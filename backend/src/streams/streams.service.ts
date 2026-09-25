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
  PaymentIntent,
  Prisma,
  PrismaClient,
  StreamAction,
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
import streamAbiJson from '../abi/TeaStream.json';
import tokenAbiJson from '../abi/TestUSD.json';
import { FundsService } from '../funds/funds.service';
import { upsertThread } from '../payments/thread';
import { SessionService } from '../identity/session.service';

const streamAbi = streamAbiJson as any;
const tokenAbi = tokenAbiJson as any;
const createPublicClient = createPublicClientBase as any;
const parseEventLogs = parseEventLogsBase as any;
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class StreamsService implements OnModuleDestroy {
  private readonly db = new PrismaClient();

  constructor(
    private readonly sessions: SessionService,
    private readonly funds: FundsService,
  ) {}

  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  private present(intent: PaymentIntent, attempt?: TransactionAttempt | null) {
    if (!intent.streamAddress || intent.durationSeconds === null) {
      throw new Error('Stream intent is incomplete');
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
      streamContract: intent.streamAddress,
      sender: intent.payerAddress,
      recipient: intent.recipientAddress,
      amountUnits: amount.toString(),
      durationSeconds: intent.durationSeconds.toString(),
      streamId: intent.streamId?.toString() ?? null,
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
                args: [intent.streamAddress as Address, amount],
              }),
            },
            create: {
              chainId: intent.chainId,
              from: intent.payerAddress,
              to: intent.streamAddress,
              value: '0',
              data: encodeFunctionData({
                abi: streamAbi,
                functionName: 'create',
                args: [
                  intent.recipientAddress as Address,
                  amount,
                  intent.durationSeconds,
                ],
              }),
            },
          }
        : null,
    };
  }

  private presentAction(action: StreamAction, intent: PaymentIntent) {
    if (!intent.streamAddress || intent.streamId === null) {
      throw new Error('Stream intent is incomplete');
    }
    return {
      id: action.id,
      streamIntentId: intent.id,
      kind: action.kind,
      state: action.state,
      txHash: action.txHash,
      amountUnits: action.amountUnits?.toString() ?? null,
      blockNumber: action.blockNumber?.toString() ?? null,
      plan:
        action.state === 'READY'
          ? {
              chainId: intent.chainId,
              from: action.actorAddress,
              to: intent.streamAddress,
              value: '0',
              data: encodeFunctionData({
                abi: streamAbi,
                functionName: action.kind as 'withdraw' | 'cancel',
                args: [BigInt(intent.streamId.toString())],
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
      throw new BadRequestException('Invalid stream');
    }
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).sort().join(',') !==
        'amountUnits,durationSeconds,recipientReference' ||
      typeof body.recipientReference !== 'string' ||
      typeof body.amountUnits !== 'string' ||
      !/^[1-9][0-9]{0,77}$/.test(body.amountUnits) ||
      BigInt(body.amountUnits) > (1n << 256n) - 1n ||
      typeof body.durationSeconds !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(body.durationSeconds) ||
      BigInt(body.durationSeconds) > (1n << 63n) - 1n
    )
      throw new BadRequestException('Invalid stream');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          recipientReference: body.recipientReference,
          amountUnits: body.amountUnits,
          durationSeconds: body.durationSeconds,
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
      if (existing.kind !== 'STREAM' || existing.requestHash !== requestHash)
        throw new ConflictException('Idempotency-Key already used');
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
      throw new BadRequestException('Cannot stream to yourself');
    }
    const streamAddress = process.env.TEA_STREAM_ADDRESS?.toLowerCase();
    if (!streamAddress || !isAddress(streamAddress) || !process.env.RPC_URL) {
      throw new ServiceUnavailableException(
        'Stream contract is not configured',
      );
    }
    const balance = await this.funds.readBalance(sender.account);
    const client = createPublicClient({
      transport: http(process.env.RPC_URL, { timeout: 5000 }),
    });
    try {
      const token = await client.readContract({
        address: streamAddress,
        abi: streamAbi,
        functionName: 'token',
        blockNumber: BigInt(balance.blockNumber),
      });
      if (token.toLowerCase() !== balance.token.toLowerCase())
        throw new Error('Wrong stream token');
    } catch {
      throw new ServiceUnavailableException('Stream contract is unavailable');
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
          if (replay.kind !== 'STREAM' || replay.requestHash !== requestHash)
            throw new ConflictException('Idempotency-Key already used');
          return replay;
        }
        const payments = await tx.paymentIntent.findMany({
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
        const claims = await tx.claim.findMany({
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
        const reserved = [...payments, ...claims].reduce(
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
            streamAddress,
            durationSeconds: BigInt(body.durationSeconds as string),
            preparedAtBlock: BigInt(balance.blockNumber),
            kind: 'STREAM',
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
    if (
      !process.env.RPC_URL ||
      !intent.streamAddress ||
      intent.durationSeconds === null
    ) {
      throw new ServiceUnavailableException('Stream network is unavailable');
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
        abi: streamAbi,
        functionName: 'create',
        args: [
          intent.recipientAddress as Address,
          BigInt(intent.amountUnits.toString()),
          intent.durationSeconds,
        ],
      });
      if (
        transaction.from.toLowerCase() !== intent.payerAddress ||
        transaction.to?.toLowerCase() !== intent.streamAddress ||
        transaction.input.toLowerCase() !== expectedData.toLowerCase() ||
        transaction.value !== 0n
      )
        throw new ConflictException('Transaction does not match stream intent');
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
        throw new ConflictException('Transaction predates stream intent');
      }
      if (receipt.status !== 'success') {
        return {
          state: 'FAILED',
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        };
      }
      const created = parseEventLogs({
        abi: streamAbi,
        eventName: 'StreamCreated',
        logs: receipt.logs,
      }).find(
        (log) =>
          log.address.toLowerCase() === intent.streamAddress &&
          log.args.sender?.toLowerCase() === intent.payerAddress &&
          log.args.recipient?.toLowerCase() === intent.recipientAddress &&
          log.args.deposit === BigInt(intent.amountUnits.toString()) &&
          BigInt(log.args.end) - BigInt(log.args.start) ===
            BigInt(intent.durationSeconds!.toString()),
      );
      const transferred = parseEventLogs({
        abi: tokenAbi,
        eventName: 'Transfer',
        logs: receipt.logs,
      }).some(
        (log) =>
          log.address.toLowerCase() === intent.tokenAddress &&
          log.args.from?.toLowerCase() === intent.payerAddress &&
          log.args.to?.toLowerCase() === intent.streamAddress &&
          log.args.value === BigInt(intent.amountUnits.toString()),
      );
      if (!created || !transferred)
        throw new ConflictException('Stream creation events do not match');
      return {
        state: 'CONFIRMED',
        streamId: created.args.streamId,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      };
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      throw new ServiceUnavailableException('Stream verification unavailable');
    }
  }

  private async chainState(intent: PaymentIntent) {
    if (
      intent.streamId === null ||
      !intent.streamAddress ||
      intent.durationSeconds === null ||
      !process.env.RPC_URL
    ) {
      throw new ServiceUnavailableException('Stream state is unavailable');
    }
    const client = createPublicClient({
      transport: http(process.env.RPC_URL, { timeout: 5000 }),
    });
    try {
      if ((await client.getChainId()) !== intent.chainId)
        throw new Error('Wrong chain');
      const block = await client.getBlock();
      const streamId = BigInt(intent.streamId.toString());
      const [stream, withdrawable] = await Promise.all([
        client.readContract({
          address: intent.streamAddress as Address,
          abi: streamAbi,
          functionName: 'streams',
          args: [streamId],
          blockNumber: block.number,
        }),
        client.readContract({
          address: intent.streamAddress as Address,
          abi: streamAbi,
          functionName: 'withdrawable',
          args: [streamId],
          blockNumber: block.number,
        }),
      ]);
      if (
        stream[0].toLowerCase() !== intent.payerAddress ||
        stream[1].toLowerCase() !== intent.recipientAddress ||
        stream[2] !== BigInt(intent.amountUnits.toString()) ||
        BigInt(stream[6]) - BigInt(stream[5]) !==
          BigInt(intent.durationSeconds.toString())
      )
        throw new Error('Stream state mismatch');
      return {
        start: stream[5].toString(),
        end: stream[6].toString(),
        withdrawnUnits: stream[3].toString(),
        canceled: stream[7],
        recipientEntitlementUnits: stream[7] ? stream[4].toString() : null,
        withdrawableUnits: withdrawable.toString(),
        blockNumber: block.number.toString(),
        blockTimestamp: block.timestamp.toString(),
      };
    } catch {
      throw new ServiceUnavailableException('Stream state is unavailable');
    }
  }

  private async readForUser(
    user: Awaited<ReturnType<SessionService['sync']>>,
    id: string,
  ) {
    const intent = await this.db.paymentIntent.findFirst({
      where: {
        id,
        kind: 'STREAM',
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
          streamId: observed.streamId?.toString() ?? null,
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

  async action(
    identityToken: string | undefined,
    idempotencyKey: string | undefined,
    id: string,
    kind: 'withdraw' | 'cancel',
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!idPattern.test(id)) throw new NotFoundException();
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    const user = await this.sessions.sync(identityToken);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ kind, actor: user.account.address }))
      .digest('hex');
    const existing = await this.db.streamAction.findUnique({
      where: { intentId_idempotencyKey: { intentId: id, idempotencyKey } },
      include: { intent: true },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictException('Idempotency-Key already used');
      return this.presentAction(existing, existing.intent);
    }
    const stream = await this.readForUser(user, id);
    if (
      stream.state !== 'CONFIRMED' ||
      !('chainState' in stream) ||
      !stream.chainState ||
      !stream.streamId
    ) {
      throw new ConflictException('Stream is not confirmed');
    }
    const expected = kind === 'withdraw' ? stream.recipient : stream.sender;
    if (user.account.address !== expected) {
      throw new ForbiddenException(
        'Current wallet does not hold this stream right',
      );
    }
    if (
      kind === 'withdraw' &&
      BigInt(stream.chainState.withdrawableUnits) === 0n
    ) {
      throw new ConflictException('Nothing is available to collect');
    }
    if (
      kind === 'cancel' &&
      (stream.chainState.canceled ||
        BigInt(stream.chainState.blockTimestamp) >=
          BigInt(stream.chainState.end))
    ) {
      throw new ConflictException('Stream can no longer be canceled');
    }
    try {
      const action = await this.db.streamAction.create({
        data: {
          intentId: id,
          chainId: stream.chainId,
          kind,
          actorAddress: expected,
          state: 'READY',
          idempotencyKey,
          requestHash,
          preparedAtBlock: BigInt(stream.chainState.blockNumber),
        },
      });
      return {
        ...this.presentAction(
          action,
          await this.db.paymentIntent.findUniqueOrThrow({ where: { id } }),
        ),
        withdrawableUnits:
          kind === 'withdraw' ? stream.chainState.withdrawableUnits : null,
        asOfBlock: stream.chainState.blockNumber,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.db.streamAction.findUnique({
          where: {
            intentId_idempotencyKey: { intentId: id, idempotencyKey },
          },
          include: { intent: true },
        });
        if (replay?.requestHash === requestHash) {
          return this.presentAction(replay, replay.intent);
        }
        throw new ConflictException('Idempotency-Key already used');
      }
      throw error;
    }
  }

  private async observeAction(
    action: StreamAction,
    intent: PaymentIntent,
    hash: Hex,
  ) {
    if (
      !process.env.RPC_URL ||
      !intent.streamAddress ||
      intent.streamId === null
    ) {
      throw new ServiceUnavailableException('Stream network is unavailable');
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
        abi: streamAbi,
        functionName: action.kind as 'withdraw' | 'cancel',
        args: [BigInt(intent.streamId.toString())],
      });
      if (
        transaction.from.toLowerCase() !== action.actorAddress ||
        transaction.to?.toLowerCase() !== intent.streamAddress ||
        transaction.input.toLowerCase() !== expectedData.toLowerCase() ||
        transaction.value !== 0n
      ) {
        throw new ConflictException('Transaction does not match stream action');
      }
      const receipt = await client
        .getTransactionReceipt({ hash })
        .catch((error: unknown) => {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        });
      if (!receipt) return { state: 'SUBMITTED' };
      if (receipt.blockNumber <= action.preparedAtBlock) {
        throw new ConflictException('Transaction predates stream action');
      }
      if (receipt.status !== 'success') {
        return {
          state: 'FAILED',
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        };
      }
      const streamId = BigInt(intent.streamId.toString());
      if (action.kind === 'withdraw') {
        const event = parseEventLogs({
          abi: streamAbi,
          eventName: 'StreamWithdrawn',
          logs: receipt.logs,
        }).find(
          (log) =>
            log.address.toLowerCase() === intent.streamAddress &&
            log.args.streamId === streamId &&
            log.args.sender?.toLowerCase() === intent.payerAddress &&
            log.args.recipient?.toLowerCase() === intent.recipientAddress &&
            log.args.amount > 0n,
        );
        const transferred = event
          ? parseEventLogs({
              abi: tokenAbi,
              eventName: 'Transfer',
              logs: receipt.logs,
            }).some(
              (log) =>
                log.address.toLowerCase() === intent.tokenAddress &&
                log.args.from?.toLowerCase() === intent.streamAddress &&
                log.args.to?.toLowerCase() === intent.recipientAddress &&
                log.args.value === event.args.amount,
            )
          : false;
        if (!event || !transferred)
          throw new ConflictException('Stream withdrawal events do not match');
        return {
          state: 'CONFIRMED',
          amountUnits: event.args.amount,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        };
      }
      const event = parseEventLogs({
        abi: streamAbi,
        eventName: 'StreamCanceled',
        logs: receipt.logs,
      }).find(
        (log) =>
          log.address.toLowerCase() === intent.streamAddress &&
          log.args.streamId === streamId &&
          log.args.sender?.toLowerCase() === intent.payerAddress &&
          log.args.recipient?.toLowerCase() === intent.recipientAddress,
      );
      const refunded =
        event?.args.senderRefund === 0n ||
        (event
          ? parseEventLogs({
              abi: tokenAbi,
              eventName: 'Transfer',
              logs: receipt.logs,
            }).some(
              (log) =>
                log.address.toLowerCase() === intent.tokenAddress &&
                log.args.from?.toLowerCase() === intent.streamAddress &&
                log.args.to?.toLowerCase() === intent.payerAddress &&
                log.args.value === event.args.senderRefund,
            )
          : false);
      if (!event || !refunded)
        throw new ConflictException('Stream cancellation events do not match');
      return {
        state: 'CONFIRMED',
        amountUnits: event.args.senderRefund,
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
        'Stream action verification unavailable',
      );
    }
  }

  private async actionForUser(
    identityToken: string,
    id: string,
    actionId: string,
  ) {
    const user = await this.sessions.sync(identityToken);
    const action = await this.db.streamAction.findFirst({
      where: {
        id: actionId,
        intentId: id,
        actorAddress: user.account.address,
      },
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
    const updated = await this.db.streamAction.update({
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
        throw new ConflictException('Stream action already submitted');
      return this.getAction(identityToken, id, actionId);
    }
    const observed = await this.observeAction(action, action.intent, hash);
    try {
      const updated = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "stream_actions" WHERE "id" = ${actionId}::uuid FOR UPDATE`;
        const current = await tx.streamAction.findUniqueOrThrow({
          where: { id: actionId },
        });
        if (
          current.submissionKey === idempotencyKey &&
          current.submissionHash !== requestHash
        ) {
          throw new ConflictException('Idempotency-Key already used');
        }
        if (current.txHash && current.txHash !== hash) {
          throw new ConflictException('Stream action already submitted');
        }
        return tx.streamAction.update({
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
    )
      throw new BadRequestException('Invalid submission');
    const rawHash = (input as { txHash?: unknown }).txHash;
    if (typeof rawHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
      throw new BadRequestException('Invalid transaction hash');
    }
    const hash = rawHash.toLowerCase() as Hex;
    const sender = await this.sessions.sync(identityToken);
    const intent = await this.db.paymentIntent.findFirst({
      where: { id, kind: 'STREAM', payerId: sender.id },
    });
    if (!intent) throw new NotFoundException();
    const requestHash = createHash('sha256').update(hash).digest('hex');
    const prior = await this.db.transactionAttempt.findFirst({
      where: { intentId: id },
    });
    if (prior) {
      if (
        prior.idempotencyKey === idempotencyKey &&
        prior.requestHash !== requestHash
      )
        throw new ConflictException('Idempotency-Key already used');
      if (prior.txHash !== hash)
        throw new ConflictException('Stream already submitted');
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
            throw new ConflictException('Stream already submitted');
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
            streamId: observed.streamId?.toString() ?? null,
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
