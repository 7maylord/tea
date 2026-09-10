import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PaymentIntent, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { FundsService } from '../funds/funds.service';
import { SessionService } from '../identity/session.service';

@Injectable()
export class PaymentsService implements OnModuleDestroy {
  private readonly db = new PrismaClient();

  constructor(
    private readonly sessions: SessionService,
    private readonly funds: FundsService,
  ) {}

  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  private present(intent: PaymentIntent) {
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
      authorizationExpiresAt: intent.authorizationExpiresAt.toISOString(),
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
            state: 'AWAITING_AUTHORIZATION',
            authorizationExpiresAt: { gt: new Date() },
          },
          select: { amountUnits: true },
        });
        const reserved = active.reduce(
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
    return this.present(intent);
  }
}
