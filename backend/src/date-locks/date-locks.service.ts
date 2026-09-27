import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DateUnlockAction,
  PaymentIntent,
  Prisma,
  PrismaClient,
  TransactionAttempt,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  createPublicClient as createPublicClientBase,
  encodeFunctionData,
  http,
  isAddress,
  parseEventLogs as parseEventLogsBase,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import dateUnlockAbiJson from '../abi/TeaDateUnlock.json';
import tokenAbiJson from '../abi/TestUSD.json';
import { FundsService } from '../funds/funds.service';
import { SessionService } from '../identity/session.service';
import { upsertThread } from '../payments/thread';

const dateUnlockAbi = dateUnlockAbiJson as any;
const tokenAbi = tokenAbiJson as any;
const createPublicClient = createPublicClientBase as any;
const parseEventLogs = parseEventLogsBase as any;
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class DateLocksService implements OnModuleDestroy {
  private readonly db = new PrismaClient();

  constructor(
    private readonly sessions: SessionService,
    private readonly funds: FundsService,
  ) {}

  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  private unlockSeconds(intent: PaymentIntent) {
    if (!intent.unlockAt) throw new Error('Date lock intent is incomplete');
    return BigInt(Math.floor(intent.unlockAt.getTime() / 1000));
  }

  private present(intent: PaymentIntent, attempt?: TransactionAttempt | null) {
    if (!intent.dateUnlockAddress || !intent.unlockAt) {
      throw new Error('Date lock intent is incomplete');
    }
    const pending =
      intent.state === 'AWAITING_AUTHORIZATION' &&
      intent.authorizationExpiresAt.getTime() > Date.now();
    const amount = BigInt(intent.amountUnits.toString());
    return {
      id: intent.id,
      state:
        intent.state === 'AWAITING_AUTHORIZATION' && !pending
          ? 'EXPIRED'
          : intent.state,
      chainId: intent.chainId,
      token: intent.tokenAddress,
      dateUnlockContract: intent.dateUnlockAddress,
      sender: intent.payerAddress,
      recipient: intent.recipientAddress,
      amountUnits: amount.toString(),
      unlockAt: intent.unlockAt.toISOString(),
      dateLockId: intent.dateLockId?.toString() ?? null,
      txHash: attempt?.txHash ?? null,
      plan: pending
        ? {
            approve: {
              chainId: intent.chainId,
              from: intent.payerAddress,
              to: intent.tokenAddress,
              value: '0',
              data: encodeFunctionData({
                abi: tokenAbi,
                functionName: 'approve',
                args: [intent.dateUnlockAddress as Address, amount],
              }),
            },
            create: {
              chainId: intent.chainId,
              from: intent.payerAddress,
              to: intent.dateUnlockAddress,
              value: '0',
              data: encodeFunctionData({
                abi: dateUnlockAbi,
                functionName: 'create',
                args: [
                  intent.recipientAddress as Address,
                  amount,
                  this.unlockSeconds(intent),
                ],
              }),
            },
          }
        : null,
    };
  }

  private presentAction(action: DateUnlockAction, intent: PaymentIntent) {
    if (!intent.dateUnlockAddress || intent.dateLockId === null) {
      throw new Error('Date lock intent is incomplete');
    }
    return {
      id: action.id,
      dateLockIntentId: intent.id,
      kind: 'withdraw',
      state: action.state,
      txHash: action.txHash,
      amountUnits: action.amountUnits?.toString() ?? null,
      blockNumber: action.blockNumber?.toString() ?? null,
      plan:
        action.state === 'READY'
          ? {
              chainId: intent.chainId,
              from: action.actorAddress,
              to: intent.dateUnlockAddress,
              value: '0',
              data: encodeFunctionData({
                abi: dateUnlockAbi,
                functionName: 'withdraw',
                args: [BigInt(intent.dateLockId.toString())],
              }),
            }
          : null,
    };
  }

  private parseUnlockAt(value: unknown) {
    if (typeof value !== 'string')
      throw new BadRequestException('Invalid date lock');
    const date = new Date(value);
    const seconds = Math.floor(date.getTime() / 1000);
    if (
      Number.isNaN(date.getTime()) ||
      seconds <= Math.floor(Date.now() / 1000) ||
      seconds > Number.MAX_SAFE_INTEGER
    ) {
      throw new BadRequestException('Invalid date lock');
    }
    return date;
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
      throw new BadRequestException('Invalid date lock');
    }
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).sort().join(',') !==
        'amountUnits,recipientReference,unlockAt' ||
      typeof body.recipientReference !== 'string' ||
      typeof body.amountUnits !== 'string' ||
      !/^[1-9][0-9]{0,77}$/.test(body.amountUnits) ||
      BigInt(body.amountUnits) > (1n << 256n) - 1n
    ) {
      throw new BadRequestException('Invalid date lock');
    }
    const unlockAt = this.parseUnlockAt(body.unlockAt);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          recipientReference: body.recipientReference,
          amountUnits: body.amountUnits,
          unlockAt: unlockAt.toISOString(),
        }),
      )
      .digest('hex');
    const sender = await this.sessions.sync(identityToken);
    if (!sender.handle)
      throw new ConflictException('Handle required before sending');
    const existing = await this.db.paymentIntent.findUnique({
      where: { payerId_idempotencyKey: { payerId: sender.id, idempotencyKey } },
    });
    if (existing) {
      if (
        existing.kind !== 'DATE_LOCK' ||
        existing.requestHash !== requestHash
      ) {
        throw new ConflictException('Idempotency-Key already used');
      }
      return this.present(existing);
    }
    const recipient = await this.sessions.recipientSnapshot(
      body.recipientReference,
      sender.id,
      sender.account.chainId,
    );
    if (
      recipient.userId === sender.id ||
      recipient.destination === sender.account.address
    ) {
      throw new BadRequestException('Cannot date-lock to yourself');
    }
    const dateUnlockAddress =
      process.env.TEA_DATE_UNLOCK_ADDRESS?.toLowerCase();
    if (
      !dateUnlockAddress ||
      !isAddress(dateUnlockAddress) ||
      !process.env.RPC_URL
    ) {
      throw new ServiceUnavailableException(
        'Date unlock contract is not configured',
      );
    }
    const balance = await this.funds.readBalance(sender.account);
    const client = createPublicClient({
      transport: http(process.env.RPC_URL, { timeout: 5000 }),
    });
    try {
      const token = await client.readContract({
        address: dateUnlockAddress,
        abi: dateUnlockAbi,
        functionName: 'token',
        blockNumber: BigInt(balance.blockNumber),
      });
      if (token.toLowerCase() !== balance.token.toLowerCase())
        throw new Error('Wrong token');
    } catch {
      throw new ServiceUnavailableException(
        'Date unlock contract is unavailable',
      );
    }
    const intent = await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${sender.id}::uuid FOR UPDATE`;
        const replay = await tx.paymentIntent.findUnique({
          where: {
            payerId_idempotencyKey: { payerId: sender.id, idempotencyKey },
          },
        });
        if (replay) {
          if (
            replay.kind !== 'DATE_LOCK' ||
            replay.requestHash !== requestHash
          ) {
            throw new ConflictException('Idempotency-Key already used');
          }
          return replay;
        }
        const active = await tx.paymentIntent.findMany({
          where: {
            payerId: sender.id,
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
            payerId: sender.id,
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
        if (
          BigInt(body.amountUnits as string) + reserved >
          BigInt(balance.balanceUnits)
        ) {
          throw new UnprocessableEntityException(
            'Insufficient available funds',
          );
        }
        const thread = await upsertThread(
          tx,
          balance.chainId,
          sender.id,
          recipient.userId,
        );
        return tx.paymentIntent.create({
          data: {
            payerId: sender.id,
            recipientUserId: recipient.userId,
            threadId: thread.id,
            chainId: balance.chainId,
            tokenAddress: balance.token.toLowerCase(),
            payerAddress: sender.account.address,
            recipientAddress: recipient.destination,
            amountUnits: body.amountUnits as string,
            dateUnlockAddress,
            unlockAt,
            preparedAtBlock: BigInt(balance.blockNumber),
            kind: 'DATE_LOCK',
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

  private async observe(intent: PaymentIntent, hash: Hex) {
    if (!process.env.RPC_URL || !intent.dateUnlockAddress || !intent.unlockAt) {
      throw new ServiceUnavailableException(
        'Date unlock network is unavailable',
      );
    }
    const client = createPublicClient({
      transport: http(process.env.RPC_URL, { timeout: 5000 }),
    });
    try {
      if ((await client.getChainId()) !== intent.chainId)
        throw new Error('Wrong chain');
      const transaction = await client
        .getTransaction({ hash })
        .catch((error: unknown) => {
          if (error instanceof TransactionNotFoundError) return null;
          throw error;
        });
      if (!transaction) return { state: 'RECONCILING' };
      const expectedData = encodeFunctionData({
        abi: dateUnlockAbi,
        functionName: 'create',
        args: [
          intent.recipientAddress as Address,
          BigInt(intent.amountUnits.toString()),
          this.unlockSeconds(intent),
        ],
      });
      if (
        transaction.from.toLowerCase() !== intent.payerAddress ||
        transaction.to?.toLowerCase() !== intent.dateUnlockAddress ||
        transaction.input.toLowerCase() !== expectedData.toLowerCase() ||
        transaction.value !== 0n
      ) {
        throw new ConflictException(
          'Transaction does not match date lock intent',
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
        throw new ConflictException('Transaction predates date lock intent');
      }
      if (receipt.status !== 'success') {
        return {
          state: 'FAILED',
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        };
      }
      const created = parseEventLogs({
        abi: dateUnlockAbi,
        eventName: 'LockCreated',
        logs: receipt.logs,
      }).find(
        (log) =>
          log.address.toLowerCase() === intent.dateUnlockAddress &&
          log.args.sender?.toLowerCase() === intent.payerAddress &&
          log.args.recipient?.toLowerCase() === intent.recipientAddress &&
          log.args.amount === BigInt(intent.amountUnits.toString()) &&
          BigInt(log.args.unlockAt) === this.unlockSeconds(intent),
      );
      const transferred = parseEventLogs({
        abi: tokenAbi,
        eventName: 'Transfer',
        logs: receipt.logs,
      }).some(
        (log) =>
          log.address.toLowerCase() === intent.tokenAddress &&
          log.args.from?.toLowerCase() === intent.payerAddress &&
          log.args.to?.toLowerCase() === intent.dateUnlockAddress &&
          log.args.value === BigInt(intent.amountUnits.toString()),
      );
      if (!created || !transferred) {
        throw new ConflictException('Date lock creation events do not match');
      }
      return {
        state: 'CONFIRMED',
        dateLockId: created.args.lockId,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      };
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      throw new ServiceUnavailableException(
        'Date lock verification unavailable',
      );
    }
  }

  private async chainState(intent: PaymentIntent) {
    if (
      !intent.dateUnlockAddress ||
      intent.dateLockId === null ||
      !process.env.RPC_URL
    ) {
      throw new ServiceUnavailableException('Date lock state is unavailable');
    }
    const client = createPublicClient({
      transport: http(process.env.RPC_URL, { timeout: 5000 }),
    });
    try {
      if ((await client.getChainId()) !== intent.chainId)
        throw new Error('Wrong chain');
      const block = await client.getBlock();
      const lockId = BigInt(intent.dateLockId.toString());
      const [lock, withdrawable] = await Promise.all([
        client.readContract({
          address: intent.dateUnlockAddress as Address,
          abi: dateUnlockAbi,
          functionName: 'locks',
          args: [lockId],
          blockNumber: block.number,
        }),
        client.readContract({
          address: intent.dateUnlockAddress as Address,
          abi: dateUnlockAbi,
          functionName: 'withdrawable',
          args: [lockId],
          blockNumber: block.number,
        }),
      ]);
      if (
        lock[0].toLowerCase() !== intent.payerAddress ||
        lock[1].toLowerCase() !== intent.recipientAddress ||
        lock[2] !== BigInt(intent.amountUnits.toString()) ||
        BigInt(lock[3]) !== this.unlockSeconds(intent)
      ) {
        throw new Error('Date lock state mismatch');
      }
      return {
        unlockAt: lock[3].toString(),
        withdrawn: lock[4],
        withdrawableUnits: withdrawable.toString(),
        blockNumber: block.number.toString(),
        blockTimestamp: block.timestamp.toString(),
      };
    } catch {
      throw new ServiceUnavailableException('Date lock state is unavailable');
    }
  }

  private async readForUser(
    user: Awaited<ReturnType<SessionService['sync']>>,
    id: string,
  ) {
    const intent = await this.db.paymentIntent.findFirst({
      where: {
        id,
        kind: 'DATE_LOCK',
        OR: [
          { payerId: user.id },
          { recipientUserId: user.id, state: 'CONFIRMED' },
        ],
      },
    });
    if (!intent) throw new NotFoundException();
    const attempt = await this.db.transactionAttempt.findFirst({
      where: { intentId: id },
      orderBy: { submittedAt: 'desc' },
    });
    if (!attempt) return this.present(intent);
    const observed = await this.observe(intent, attempt.txHash as Hex);
    if (
      observed.state === attempt.state &&
      (observed.blockHash ?? null) === attempt.blockHash
    ) {
      return {
        ...this.present(intent, attempt),
        chainState:
          intent.state === 'CONFIRMED' ? await this.chainState(intent) : null,
      };
    }
    const [nextAttempt, nextIntent] = await this.db.$transaction([
      this.db.transactionAttempt.update({
        where: { id: attempt.id },
        data: {
          state: observed.state,
          blockNumber: observed.blockNumber ?? null,
          blockHash: observed.blockHash ?? null,
          confirmedAt: observed.state === 'CONFIRMED' ? new Date() : null,
        },
      }),
      this.db.paymentIntent.update({
        where: { id },
        data: {
          state: observed.state,
          dateLockId: observed.dateLockId?.toString() ?? null,
        },
      }),
    ]);
    if (observed.state === 'CONFIRMED' && intent.threadId) {
      await this.db.thread.update({
        where: { id: intent.threadId },
        data: { lastActivityAt: new Date() },
      });
    }
    return {
      ...this.present(nextIntent, nextAttempt),
      chainState:
        nextIntent.state === 'CONFIRMED'
          ? await this.chainState(nextIntent)
          : null,
    };
  }

  async get(identityToken: string | undefined, id: string) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!idPattern.test(id)) throw new NotFoundException();
    const user = await this.sessions.sync(identityToken);
    return this.readForUser(user, id);
  }

  async withdraw(
    identityToken: string | undefined,
    idempotencyKey: string | undefined,
    id: string,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!idPattern.test(id)) throw new NotFoundException();
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    const user = await this.sessions.sync(identityToken);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ kind: 'withdraw', actor: user.account.address }))
      .digest('hex');
    const existing = await this.db.dateUnlockAction.findUnique({
      where: { intentId_idempotencyKey: { intentId: id, idempotencyKey } },
      include: { intent: true },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictException('Idempotency-Key already used');
      return this.presentAction(existing, existing.intent);
    }
    const dateLock = await this.readForUser(user, id);
    if (
      dateLock.state !== 'CONFIRMED' ||
      !('chainState' in dateLock) ||
      !dateLock.chainState ||
      !dateLock.dateLockId
    ) {
      throw new ConflictException('Date lock is not confirmed');
    }
    if (user.account.address !== dateLock.recipient) {
      throw new ForbiddenException(
        'Current wallet cannot collect this date lock',
      );
    }
    if (dateLock.chainState.withdrawn)
      throw new ConflictException('Date lock already collected');
    if (
      BigInt(dateLock.chainState.blockTimestamp) <
      BigInt(dateLock.chainState.unlockAt)
    ) {
      throw new ConflictException('Date lock is still locked');
    }
    if (BigInt(dateLock.chainState.withdrawableUnits) === 0n) {
      throw new ConflictException('Nothing is available to collect');
    }
    try {
      const action = await this.db.dateUnlockAction.create({
        data: {
          intentId: id,
          chainId: dateLock.chainId,
          actorAddress: dateLock.recipient,
          state: 'READY',
          idempotencyKey,
          requestHash,
          preparedAtBlock: BigInt(dateLock.chainState.blockNumber),
        },
      });
      return {
        ...this.presentAction(
          action,
          await this.db.paymentIntent.findUniqueOrThrow({ where: { id } }),
        ),
        withdrawableUnits: dateLock.chainState.withdrawableUnits,
        asOfBlock: dateLock.chainState.blockNumber,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.db.dateUnlockAction.findUnique({
          where: { intentId_idempotencyKey: { intentId: id, idempotencyKey } },
          include: { intent: true },
        });
        if (replay?.requestHash === requestHash)
          return this.presentAction(replay, replay.intent);
        throw new ConflictException('Idempotency-Key already used');
      }
      throw error;
    }
  }

  private async observeAction(
    action: DateUnlockAction,
    intent: PaymentIntent,
    hash: Hex,
  ) {
    if (
      !process.env.RPC_URL ||
      !intent.dateUnlockAddress ||
      intent.dateLockId === null
    ) {
      throw new ServiceUnavailableException('Date lock network is unavailable');
    }
    const client = createPublicClient({
      transport: http(process.env.RPC_URL, { timeout: 5000 }),
    });
    try {
      if ((await client.getChainId()) !== intent.chainId)
        throw new Error('Wrong chain');
      const transaction = await client
        .getTransaction({ hash })
        .catch((error: unknown) => {
          if (error instanceof TransactionNotFoundError) return null;
          throw error;
        });
      if (!transaction) return { state: 'RECONCILING' };
      const expectedData = encodeFunctionData({
        abi: dateUnlockAbi,
        functionName: 'withdraw',
        args: [BigInt(intent.dateLockId.toString())],
      });
      if (
        transaction.from.toLowerCase() !== action.actorAddress ||
        transaction.to?.toLowerCase() !== intent.dateUnlockAddress ||
        transaction.input.toLowerCase() !== expectedData.toLowerCase() ||
        transaction.value !== 0n
      ) {
        throw new ConflictException(
          'Transaction does not match date lock action',
        );
      }
      const receipt = await client
        .getTransactionReceipt({ hash })
        .catch((error: unknown) => {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        });
      if (!receipt) return { state: 'SUBMITTED' };
      if (receipt.blockNumber <= action.preparedAtBlock) {
        throw new ConflictException('Transaction predates date lock action');
      }
      if (receipt.status !== 'success') {
        return {
          state: 'FAILED',
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        };
      }
      const lockId = BigInt(intent.dateLockId.toString());
      const event = parseEventLogs({
        abi: dateUnlockAbi,
        eventName: 'LockWithdrawn',
        logs: receipt.logs,
      }).find(
        (log) =>
          log.address.toLowerCase() === intent.dateUnlockAddress &&
          log.args.lockId === lockId &&
          log.args.sender?.toLowerCase() === intent.payerAddress &&
          log.args.recipient?.toLowerCase() === intent.recipientAddress &&
          log.args.amount === BigInt(intent.amountUnits.toString()),
      );
      const transferred = event
        ? parseEventLogs({
            abi: tokenAbi,
            eventName: 'Transfer',
            logs: receipt.logs,
          }).some(
            (log) =>
              log.address.toLowerCase() === intent.tokenAddress &&
              log.args.from?.toLowerCase() === intent.dateUnlockAddress &&
              log.args.to?.toLowerCase() === intent.recipientAddress &&
              log.args.value === event.args.amount,
          )
        : false;
      if (!event || !transferred) {
        throw new ConflictException('Date lock withdrawal events do not match');
      }
      return {
        state: 'CONFIRMED',
        amountUnits: event.args.amount,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      };
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      throw new ServiceUnavailableException(
        'Date lock action verification unavailable',
      );
    }
  }

  private async actionForUser(
    identityToken: string,
    id: string,
    actionId: string,
  ) {
    const user = await this.sessions.sync(identityToken);
    const action = await this.db.dateUnlockAction.findFirst({
      where: { id: actionId, intentId: id, actorAddress: user.account.address },
      include: { intent: true },
    });
    if (!action) throw new NotFoundException();
    return action;
  }

  async getAction(
    identityToken: string | undefined,
    id: string,
    actionId: string,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!idPattern.test(id) || !idPattern.test(actionId))
      throw new NotFoundException();
    const action = await this.actionForUser(identityToken, id, actionId);
    if (!action.txHash) return this.presentAction(action, action.intent);
    const observed = await this.observeAction(
      action,
      action.intent,
      action.txHash as Hex,
    );
    if (
      observed.state === action.state &&
      (observed.blockHash ?? null) === action.blockHash
    ) {
      return this.presentAction(action, action.intent);
    }
    const updated = await this.db.dateUnlockAction.update({
      where: { id: action.id },
      data: {
        state: observed.state,
        amountUnits: observed.amountUnits?.toString() ?? null,
        blockNumber: observed.blockNumber ?? null,
        blockHash: observed.blockHash ?? null,
      },
    });
    return this.presentAction(updated, action.intent);
  }

  async registerAction(
    identityToken: string | undefined,
    id: string,
    actionId: string,
    idempotencyKey: string | undefined,
    input: unknown,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!idPattern.test(id) || !idPattern.test(actionId))
      throw new NotFoundException();
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
    const requestHash = createHash('sha256').update(hash).digest('hex');
    const action = await this.actionForUser(identityToken, id, actionId);
    if (
      action.submissionKey === idempotencyKey &&
      action.submissionHash !== requestHash
    ) {
      throw new ConflictException('Idempotency-Key already used');
    }
    if (action.txHash) {
      if (action.txHash !== hash)
        throw new ConflictException('Date lock action already submitted');
      return this.getAction(identityToken, id, actionId);
    }
    const observed = await this.observeAction(action, action.intent, hash);
    try {
      const updated = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "date_unlock_actions" WHERE "id" = ${actionId}::uuid FOR UPDATE`;
        const current = await tx.dateUnlockAction.findUniqueOrThrow({
          where: { id: actionId },
        });
        if (
          current.submissionKey === idempotencyKey &&
          current.submissionHash !== requestHash
        ) {
          throw new ConflictException('Idempotency-Key already used');
        }
        if (current.txHash && current.txHash !== hash) {
          throw new ConflictException('Date lock action already submitted');
        }
        return tx.dateUnlockAction.update({
          where: { id: actionId },
          data: {
            txHash: hash,
            submissionKey: idempotencyKey,
            submissionHash: requestHash,
            state: observed.state,
            amountUnits: observed.amountUnits?.toString() ?? null,
            blockNumber: observed.blockNumber ?? null,
            blockHash: observed.blockHash ?? null,
          },
        });
      });
      return this.presentAction(updated, action.intent);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Transaction is already registered');
      }
      throw error;
    }
  }

  async register(
    identityToken: string | undefined,
    id: string,
    idempotencyKey: string | undefined,
    input: unknown,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!idPattern.test(id)) throw new NotFoundException();
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
    const sender = await this.sessions.sync(identityToken);
    const intent = await this.db.paymentIntent.findFirst({
      where: { id, kind: 'DATE_LOCK', payerId: sender.id },
    });
    if (!intent) throw new NotFoundException();
    if (intent.preparedAtBlock === null)
      throw new ConflictException('Create a new date lock intent');
    const requestHash = createHash('sha256').update(hash).digest('hex');
    const prior = await this.db.transactionAttempt.findFirst({
      where: { intentId: id },
    });
    if (prior) {
      if (
        prior.idempotencyKey === idempotencyKey &&
        prior.requestHash !== requestHash
      ) {
        throw new ConflictException('Idempotency-Key already used');
      }
      if (prior.txHash !== hash)
        throw new ConflictException('Date lock already submitted');
      return this.get(identityToken, id);
    }
    const observed = await this.observe(intent, hash);
    try {
      const saved = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "payment_intents" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const replay = await tx.transactionAttempt.findFirst({
          where: { intentId: id },
        });
        if (replay) {
          if (replay.txHash !== hash)
            throw new ConflictException('Date lock already submitted');
          return { intent, attempt: replay };
        }
        const attempt = await tx.transactionAttempt.create({
          data: {
            intentId: id,
            operationIndex: 1,
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
          data: {
            state: observed.state,
            dateLockId: observed.dateLockId?.toString() ?? null,
          },
        });
        if (observed.state === 'CONFIRMED' && intent.threadId) {
          await tx.thread.update({
            where: { id: intent.threadId },
            data: { lastActivityAt: new Date() },
          });
        }
        return { intent: updated, attempt };
      });
      return this.present(saved.intent, saved.attempt);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Transaction is already registered');
      }
      throw error;
    }
  }
}
