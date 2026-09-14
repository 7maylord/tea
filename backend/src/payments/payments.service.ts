import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PaymentIntent,
  Prisma,
  PrismaClient,
  TransactionAttempt,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import { FundsService } from '../funds/funds.service';
import { SessionService } from '../identity/session.service';

@Injectable()
export class PaymentsService implements OnModuleDestroy {
  private readonly db = new PrismaClient();
  private readonly activityPageSize = 20;

  constructor(
    private readonly sessions: SessionService,
    private readonly funds: FundsService,
  ) {}

  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  async activity(identityToken: string | undefined, cursor?: string) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (
      cursor !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        cursor,
      )
    ) {
      throw new BadRequestException('Invalid activity cursor');
    }
    const user = await this.sessions.sync(identityToken);
    const where: Prisma.PaymentIntentWhereInput = {
      OR: [
        { payerId: user.id },
        { recipientUserId: user.id, state: 'CONFIRMED' },
      ],
    };
    if (cursor) {
      const visible = await this.db.paymentIntent.findFirst({
        where: { ...where, id: cursor },
        select: { id: true },
      });
      if (!visible) throw new BadRequestException('Invalid activity cursor');
    }
    const rows = await this.db.paymentIntent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.activityPageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        payer: { select: { handle: true } },
        recipient: { select: { handle: true } },
        attempts: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: { txHash: true, blockNumber: true },
        },
      },
    });
    const items = rows.slice(0, this.activityPageSize).map((intent) => {
      const outgoing = intent.payerId === user.id;
      return {
        id: intent.id,
        direction: outgoing ? 'OUTGOING' : 'INCOMING',
        state:
          intent.state === 'AWAITING_AUTHORIZATION' &&
          intent.authorizationExpiresAt.getTime() <= Date.now()
            ? 'EXPIRED'
            : intent.state,
        counterpartyHandle: outgoing
          ? (intent.recipient?.handle ?? null)
          : intent.payer.handle,
        amountUnits: intent.amountUnits.toString(),
        token: intent.tokenAddress,
        createdAt: intent.createdAt.toISOString(),
        txHash: intent.attempts[0]?.txHash ?? null,
        blockNumber: intent.attempts[0]?.blockNumber?.toString() ?? null,
      };
    });
    return {
      items,
      nextCursor:
        rows.length > this.activityPageSize
          ? items[this.activityPageSize - 1].id
          : null,
    };
  }

  private present(intent: PaymentIntent, attempt?: TransactionAttempt | null) {
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
              abi: erc20Abi,
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

  private async observe(
    intent: PaymentIntent,
    hash: Hex,
  ): Promise<{ state: string; blockNumber?: bigint; blockHash?: Hex }> {
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) throw new ServiceUnavailableException('RPC is not configured');
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    try {
      if ((await client.getChainId()) !== intent.chainId) {
        throw new ServiceUnavailableException('Wrong settlement chain');
      }
      const transaction = await client
        .getTransaction({ hash })
        .catch((error: unknown) => {
          if (error instanceof TransactionNotFoundError) return null;
          throw error;
        });
      if (!transaction) return { state: 'RECONCILING' };
      const expectedData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [
          intent.recipientAddress as Address,
          BigInt(intent.amountUnits.toString()),
        ],
      });
      if (
        transaction.from.toLowerCase() !== intent.payerAddress ||
        transaction.to?.toLowerCase() !== intent.tokenAddress ||
        transaction.input.toLowerCase() !== expectedData.toLowerCase() ||
        transaction.value !== 0n
      ) {
        throw new ConflictException(
          'Transaction does not match payment intent',
        );
      }
      const receipt = await client
        .getTransactionReceipt({ hash })
        .catch((error: unknown) => {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        });
      if (!receipt) return { state: 'SUBMITTED' };
      if (
        intent.preparedAtBlock === null ||
        receipt.blockNumber <= intent.preparedAtBlock
      ) {
        throw new ConflictException('Transaction predates payment intent');
      }
      const transfers = parseEventLogs({
        abi: erc20Abi,
        eventName: 'Transfer',
        logs: receipt.logs,
      });
      const paid = transfers.some(
        (log) =>
          log.address.toLowerCase() === intent.tokenAddress &&
          log.args.from?.toLowerCase() === intent.payerAddress &&
          log.args.to?.toLowerCase() === intent.recipientAddress &&
          log.args.value === BigInt(intent.amountUnits.toString()),
      );
      return {
        state: receipt.status === 'success' && paid ? 'CONFIRMED' : 'FAILED',
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      };
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException(
        'Transaction verification unavailable',
      );
    }
  }

  async create(
    identityToken: string | undefined,
    idempotencyKey: string | undefined,
    input: unknown,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Invalid payment');
    }
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).sort().join(',') !== 'amountUnits,recipientReference' ||
      typeof body.recipientReference !== 'string' ||
      typeof body.amountUnits !== 'string' ||
      !/^[1-9][0-9]{0,77}$/.test(body.amountUnits)
    ) {
      throw new BadRequestException('Invalid payment');
    }
    const amount = BigInt(body.amountUnits);
    if (amount > (1n << 256n) - 1n) {
      throw new BadRequestException('Invalid amount');
    }
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          recipientReference: body.recipientReference,
          amountUnits: body.amountUnits,
        }),
      )
      .digest('hex');
    const payer = await this.sessions.sync(identityToken);
    if (!payer.handle)
      throw new ConflictException('Handle required before sending');

    const existing = await this.db.paymentIntent.findUnique({
      where: {
        payerId_idempotencyKey: { payerId: payer.id, idempotencyKey },
      },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictException('Idempotency-Key already used');
      return this.present(existing);
    }

    const recipient = await this.sessions.recipientSnapshot(
      body.recipientReference,
      payer.id,
      payer.account.chainId,
    );
    if (
      recipient.userId === payer.id ||
      recipient.destination === payer.account.address
    ) {
      throw new BadRequestException('Cannot pay yourself');
    }
    const intent = await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${payer.id}::uuid FOR UPDATE`;
        const replay = await tx.paymentIntent.findUnique({
          where: {
            payerId_idempotencyKey: { payerId: payer.id, idempotencyKey },
          },
        });
        if (replay) {
          if (replay.requestHash !== requestHash)
            throw new ConflictException('Idempotency-Key already used');
          return replay;
        }
        const balance = await this.funds.readBalance(payer.account);
        const tokenAddress = balance.token.toLowerCase();
        const active = await tx.paymentIntent.findMany({
          where: {
            payerId: payer.id,
            chainId: balance.chainId,
            tokenAddress,
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
            tokenAddress,
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
        if (amount + reserved > BigInt(balance.balanceUnits)) {
          throw new UnprocessableEntityException(
            'Insufficient available funds',
          );
        }
        return tx.paymentIntent.create({
          data: {
            payerId: payer.id,
            recipientUserId: recipient.userId,
            chainId: balance.chainId,
            tokenAddress,
            payerAddress: payer.account.address,
            recipientAddress: recipient.destination,
            amountUnits: body.amountUnits as string,
            preparedAtBlock: BigInt(balance.blockNumber),
            kind: 'DIRECT',
            state: 'AWAITING_AUTHORIZATION',
            idempotencyKey,
            requestHash,
            authorizationExpiresAt: new Date(Date.now() + 600_000),
          },
        });
      },
      { timeout: 15_000 },
    );
    return this.present(intent);
  }

  async get(identityToken: string | undefined, id: string) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ) {
      throw new NotFoundException();
    }
    const payer = await this.sessions.sync(identityToken);
    const intent = await this.db.paymentIntent.findFirst({
      where: { id, payerId: payer.id },
    });
    if (!intent) throw new NotFoundException();
    const attempt = await this.db.transactionAttempt.findFirst({
      where: { intentId: intent.id },
      orderBy: { submittedAt: 'desc' },
    });
    if (!attempt) return this.present(intent);
    const observed = await this.observe(intent, attempt.txHash as Hex);
    if (
      observed.state !== attempt.state ||
      (observed.blockHash ?? null) !== attempt.blockHash
    ) {
      const updated = await this.db.$transaction(async (tx) => {
        const [nextAttempt, nextIntent] = await Promise.all([
          tx.transactionAttempt.update({
            where: { id: attempt.id },
            data: {
              state: observed.state,
              blockNumber: observed.blockNumber ?? null,
              blockHash: observed.blockHash ?? null,
              confirmedAt: observed.state === 'CONFIRMED' ? new Date() : null,
            },
          }),
          tx.paymentIntent.update({
            where: { id: intent.id },
            data: { state: observed.state },
          }),
        ]);
        return { nextAttempt, nextIntent };
      });
      return this.present(updated.nextIntent, updated.nextAttempt);
    }
    return this.present(intent, attempt);
  }

  async register(
    identityToken: string | undefined,
    id: string,
    idempotencyKey: string | undefined,
    input: unknown,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ) {
      throw new NotFoundException();
    }
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).join(',') !== 'txHash'
    ) {
      throw new BadRequestException('Invalid submission');
    }
    const rawHash = (input as { txHash?: unknown }).txHash;
    if (typeof rawHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
      throw new BadRequestException('Invalid transaction hash');
    }
    const hash = rawHash.toLowerCase() as Hex;
    const payer = await this.sessions.sync(identityToken);
    const intent = await this.db.paymentIntent.findFirst({
      where: { id, payerId: payer.id },
    });
    if (!intent) throw new NotFoundException();
    if (intent.preparedAtBlock === null) {
      throw new ConflictException('Create a new payment intent');
    }
    const requestHash = createHash('sha256').update(hash).digest('hex');
    const existing = await this.db.transactionAttempt.findFirst({
      where: { intentId: id },
    });
    if (existing) {
      if (
        existing.idempotencyKey === idempotencyKey &&
        existing.requestHash !== requestHash
      ) {
        throw new ConflictException('Idempotency-Key already used');
      }
      if (existing.txHash !== hash)
        throw new ConflictException('Payment already submitted');
      return this.get(identityToken, id);
    }
    const observed = await this.observe(intent, hash);
    let result: { attempt: TransactionAttempt; intent: PaymentIntent };
    try {
      result = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "payment_intents" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const replay = await tx.transactionAttempt.findFirst({
          where: { intentId: id },
        });
        if (replay) {
          if (replay.txHash !== hash)
            throw new ConflictException('Payment already submitted');
          return { attempt: replay, intent };
        }
        const attempt = await tx.transactionAttempt.create({
          data: {
            intentId: id,
            operationIndex: 0,
            chainId: intent.chainId,
            txHash: hash,
            state: observed.state,
            idempotencyKey,
            requestHash,
            blockNumber: observed.blockNumber,
            blockHash: observed.blockHash,
            confirmedAt: observed.state === 'CONFIRMED' ? new Date() : null,
          },
        });
        const updated = await tx.paymentIntent.update({
          where: { id },
          data: { state: observed.state },
        });
        return { attempt, intent: updated };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Transaction is already registered');
      }
      throw error;
    }
    return this.present(result.intent, result.attempt);
  }
}
