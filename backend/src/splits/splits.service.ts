import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PaymentIntent,
  PrismaClient,
  TransactionAttempt,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { encodeFunctionData, isAddress, type Address } from 'viem';
import tokenAbiJson from '../abi/TestUSD.json';
import { notifySplitParticipant } from '../email/notifications';
import { FundsService } from '../funds/funds.service';
import { SessionService } from '../identity/session.service';
import { upsertThread } from '../payments/thread';

const tokenAbi = tokenAbiJson as any;
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function splitAmount(total: bigint, count: number) {
  if (
    total <= 0n ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    total < BigInt(count)
  ) {
    throw new Error('Invalid split');
  }
  const base = total / BigInt(count);
  const remainder = Number(total % BigInt(count));
  return Array.from(
    { length: count },
    (_, index) => base + (index < remainder ? 1n : 0n),
  );
}

@Injectable()
export class SplitsService implements OnModuleDestroy {
  private readonly db = new PrismaClient();

  constructor(
    private readonly sessions: SessionService,
    private readonly funds: FundsService,
  ) {}

  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  private async notifyParticipants(split: any) {
    await Promise.allSettled(
      split.obligations.map((obligation: any) =>
        notifySplitParticipant(this.db, obligation.id),
      ),
    );
  }

  private presentPayment(
    intent: PaymentIntent,
    attempt?: TransactionAttempt | null,
  ) {
    const pending =
      intent.state === 'AWAITING_AUTHORIZATION' &&
      intent.authorizationExpiresAt.getTime() > Date.now();
    return {
      id: intent.id,
      state:
        intent.state === 'AWAITING_AUTHORIZATION' && !pending
          ? 'EXPIRED'
          : intent.state,
      chainId: intent.chainId,
      token: intent.tokenAddress,
      payer: intent.payerAddress,
      recipient: intent.recipientAddress,
      amountUnits: intent.amountUnits.toString(),
      preparedAtBlock: intent.preparedAtBlock?.toString() ?? null,
      authorizationExpiresAt: intent.authorizationExpiresAt.toISOString(),
      attempt: attempt
        ? {
            txHash: attempt.txHash,
            state: attempt.state,
            blockNumber: attempt.blockNumber?.toString() ?? null,
          }
        : null,
      plan: pending
        ? {
            chainId: intent.chainId,
            from: intent.payerAddress,
            to: intent.tokenAddress,
            value: '0',
            data: encodeFunctionData({
              abi: tokenAbi,
              functionName: 'transfer',
              args: [
                intent.recipientAddress as Address,
                BigInt(intent.amountUnits.toString()),
              ],
            }),
          }
        : null,
    };
  }

  async create(
    identityToken: string | undefined,
    idempotencyKey: string | undefined,
    input: unknown,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Session token required');
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey))
      throw new BadRequestException('Invalid Idempotency-Key');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Invalid split');
    const body = input as Record<string, unknown>;
    if (
      !Array.isArray(body.obligations) ||
      typeof body.token !== 'string' ||
      !isAddress(body.token) ||
      body.obligations.length < 1 ||
      body.obligations.length > 20 ||
      (body.title !== undefined &&
        (typeof body.title !== 'string' || body.title.length > 80))
    )
      throw new BadRequestException('Invalid split');
    const obligations = body.obligations.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new BadRequestException('Invalid split');
      }
      const row = item as Record<string, unknown>;
      if (
        typeof row.recipientReference !== 'string' ||
        typeof row.amountUnits !== 'string' ||
        !/^[1-9][0-9]{0,77}$/.test(row.amountUnits)
      ) {
        throw new BadRequestException('Invalid split');
      }
      const amount = BigInt(row.amountUnits);
      if (amount > (1n << 256n) - 1n) {
        throw new BadRequestException('Invalid split');
      }
      return { recipientReference: row.recipientReference, amount };
    });
    const total = obligations.reduce((sum, item) => sum + item.amount, 0n);
    if (total > (1n << 256n) - 1n)
      throw new BadRequestException('Invalid split');
    const organizer = await this.sessions.sync(identityToken);
    if (!organizer.handle)
      throw new ConflictException('Handle required before creating a split');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          title: body.title ?? '',
          token: body.token.toLowerCase(),
          obligations: obligations.map((item) => ({
            recipientReference: item.recipientReference,
            amountUnits: item.amount.toString(),
          })),
        }),
      )
      .digest('hex');
    const existing = await this.db.split.findUnique({
      where: {
        organizerId_idempotencyKey: {
          organizerId: organizer.id,
          idempotencyKey,
        },
      },
      include: {
        obligations: {
          include: { participant: { select: { handle: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictException('Idempotency-Key already used');
      await this.notifyParticipants(existing);
      return this.presentSplit(existing);
    }
    const balance = await this.funds.readBalance(organizer.account, body.token);
    const snapshots = await Promise.all(
      obligations.map((obligation) =>
        this.sessions.recipientSnapshot(
          obligation.recipientReference,
          organizer.id,
          organizer.account.chainId,
        ),
      ),
    );
    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      if (
        snapshot.userId === organizer.id ||
        snapshot.destination === organizer.account.address
      )
        throw new BadRequestException('Cannot split with yourself');
      if (seen.has(snapshot.userId))
        throw new BadRequestException('Duplicate split member');
      seen.add(snapshot.userId);
    }
    const split = await this.db.$transaction(async (tx) => {
      const replay = await tx.split.findUnique({
        where: {
          organizerId_idempotencyKey: {
            organizerId: organizer.id,
            idempotencyKey,
          },
        },
      });
      if (replay) {
        if (replay.requestHash !== requestHash)
          throw new ConflictException('Idempotency-Key already used');
        return replay;
      }
      return tx.split.create({
        data: {
          organizerId: organizer.id,
          chainId: balance.chainId,
          tokenAddress: balance.token.toLowerCase(),
          organizerAddress: organizer.account.address,
          title:
            typeof body.title === 'string' && body.title.trim()
              ? body.title.trim()
              : null,
          totalAmountUnits: total.toString(),
          state: 'OPEN',
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          idempotencyKey,
          requestHash,
          obligations: {
            create: snapshots.map((snapshot, index) => ({
              participantUserId: snapshot.userId,
              participantAddress: snapshot.destination,
              amountUnits: obligations[index].amount.toString(),
              state: 'OPEN',
            })),
          },
        },
      });
    });
    const loaded = await this.db.split.findUniqueOrThrow({
      where: { id: split.id },
      include: {
        obligations: {
          include: { participant: { select: { handle: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    await this.notifyParticipants(loaded);
    return this.presentSplit(loaded);
  }

  async list(identityToken: string | undefined) {
    if (!identityToken)
      throw new UnauthorizedException('Session token required');
    const user = await this.sessions.sync(identityToken);
    const rows = await this.db.split.findMany({
      where: {
        OR: [
          { organizerId: user.id },
          { obligations: { some: { participantUserId: user.id } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        organizer: { select: { handle: true } },
        obligations: {
          include: {
            participant: { select: { handle: true } },
            paymentIntent: {
              include: {
                attempts: { orderBy: { submittedAt: 'desc' }, take: 1 },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return { items: rows.map((split) => this.presentSplit(split, user.id)) };
  }

  async preparePayment(
    identityToken: string | undefined,
    splitId: string,
    obligationId: string,
    idempotencyKey: string | undefined,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Session token required');
    if (!idPattern.test(splitId) || !idPattern.test(obligationId))
      throw new NotFoundException('Split request not found');
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey))
      throw new BadRequestException('Invalid Idempotency-Key');
    const payer = await this.sessions.sync(identityToken);
    if (!payer.handle)
      throw new ConflictException('Handle required before paying');
    const obligation = await this.db.splitObligation.findFirst({
      where: { id: obligationId, splitId, participantUserId: payer.id },
      include: {
        split: true,
        paymentIntent: {
          include: { attempts: { orderBy: { submittedAt: 'desc' }, take: 1 } },
        },
      },
    });
    if (!obligation) throw new NotFoundException('Split request not found');
    if (obligation.paymentIntent)
      return this.presentPayment(
        obligation.paymentIntent,
        obligation.paymentIntent.attempts[0],
      );
    if (obligation.state === 'PAID')
      throw new ConflictException('Split request is already paid');
    if (obligation.split.expiresAt.getTime() <= Date.now())
      throw new GoneException('Split request expired');
    if (obligation.participantAddress !== payer.account.address)
      throw new ConflictException('Settlement wallet changed');
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ splitId, obligationId }))
      .digest('hex');
    const existing = await this.db.paymentIntent.findUnique({
      where: { payerId_idempotencyKey: { payerId: payer.id, idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictException('Idempotency-Key already used');
      return this.presentPayment(existing);
    }
    const balance = await this.funds.readBalance(
      payer.account,
      obligation.split.tokenAddress,
    );
    const amount = BigInt(obligation.amountUnits.toString());
    const intent = await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${payer.id}::uuid FOR UPDATE`;
        const replay = await tx.splitObligation.findFirst({
          where: { id: obligationId, paymentIntentId: { not: null } },
          include: { paymentIntent: true },
        });
        if (replay?.paymentIntent) return replay.paymentIntent;
        const active = await tx.paymentIntent.findMany({
          where: {
            payerId: payer.id,
            chainId: balance.chainId,
            tokenAddress: balance.token.toLowerCase(),
            OR: [
              {
                state: 'AWAITING_AUTHORIZATION',
                authorizationExpiresAt: { gt: new Date() },
              },
              { state: { in: ['SUBMITTED', 'RECONCILING'] } },
            ],
          },
          select: { amountUnits: true },
        });
        const pendingClaims = await tx.claim.findMany({
          where: {
            payerId: payer.id,
            chainId: balance.chainId,
            tokenAddress: balance.token.toLowerCase(),
            OR: [
              {
                state: 'AWAITING_DEPOSIT',
                preparationExpiresAt: { gt: new Date() },
              },
              { state: { in: ['SUBMITTED', 'RECONCILING'] } },
            ],
          },
          select: { amountUnits: true },
        });
        const reserved = [...active, ...pendingClaims].reduce(
          (total, item) => total + BigInt(item.amountUnits.toString()),
          0n,
        );
        if (amount + reserved > BigInt(balance.balanceUnits))
          throw new UnprocessableEntityException(
            'Insufficient available funds',
          );
        const thread = await upsertThread(
          tx,
          balance.chainId,
          payer.id,
          obligation.split.organizerId,
        );
        const created = await tx.paymentIntent.create({
          data: {
            payerId: payer.id,
            recipientUserId: obligation.split.organizerId,
            threadId: thread.id,
            chainId: balance.chainId,
            tokenAddress: balance.token.toLowerCase(),
            payerAddress: payer.account.address,
            recipientAddress: obligation.split.organizerAddress,
            amountUnits: obligation.amountUnits.toString(),
            preparedAtBlock: BigInt(balance.blockNumber),
            kind: 'DIRECT',
            state: 'AWAITING_AUTHORIZATION',
            idempotencyKey,
            requestHash,
            authorizationExpiresAt: new Date(Date.now() + 600_000),
          },
        });
        await tx.splitObligation.update({
          where: { id: obligationId },
          data: { paymentIntentId: created.id, state: 'PAYMENT_REQUESTED' },
        });
        return created;
      },
      { timeout: 15_000 },
    );
    return this.presentPayment(intent);
  }

  private presentSplit(split: any, viewerId?: string) {
    const expired = split.expiresAt.getTime() <= Date.now();
    return {
      id: split.id,
      title: split.title,
      role:
        viewerId && split.organizerId !== viewerId
          ? 'participant'
          : 'organizer',
      organizerHandle:
        'organizer' in split ? (split.organizer?.handle ?? null) : null,
      state: expired && split.state === 'OPEN' ? 'EXPIRED' : split.state,
      totalAmountUnits: split.totalAmountUnits.toString(),
      token: split.tokenAddress,
      expiresAt: split.expiresAt.toISOString(),
      obligations: split.obligations
        .filter(
          (obligation) =>
            !viewerId ||
            split.organizerId === viewerId ||
            obligation.participantUserId === viewerId,
        )
        .map((obligation) => ({
          id: obligation.id,
          participantHandle: obligation.participant.handle,
          amountUnits: obligation.amountUnits.toString(),
          state:
            expired && obligation.state === 'OPEN'
              ? 'EXPIRED'
              : obligation.state,
          paymentIntentId: obligation.paymentIntentId,
          paymentState: obligation.paymentIntent?.state ?? null,
          txHash: obligation.paymentIntent?.attempts?.[0]?.txHash ?? null,
        })),
    };
  }
}
