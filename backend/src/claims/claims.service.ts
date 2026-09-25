import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Claim, Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import {
  createPublicClient as createPublicClientBase,
  encodeFunctionData,
  http,
  isAddress,
  parseEventLogs as parseEventLogsBase,
  toHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import escrowAbiJson from '../abi/TeaClaimEscrow.json';
import tokenAbiJson from '../abi/TestUSD.json';
import { FundsService } from '../funds/funds.service';
import { SessionService } from '../identity/session.service';
import {
  encryptIdentity,
  identityKey,
  normalizeEmail,
  readIdentityKey,
} from '../identity/identity.crypto';
import { claimIdentityCommitment, newClaimBinding } from './claim.crypto';
import {
  claimAcceptanceDigest,
  claimAcceptanceTypedData,
  claimAuthorizationDigest,
  claimAuthorizationTypedData,
} from './claim.typed-data';

const escrowAbi = escrowAbiJson as any;
const tokenAbi = tokenAbiJson as any;
const createPublicClient = createPublicClientBase as any;
const parseEventLogs = parseEventLogsBase as any;

@Injectable()
export class ClaimsService implements OnModuleDestroy {
  private readonly db = new PrismaClient();

  private jobsForOpenClaim(
    claimId: string,
    expiry: Date,
  ): Prisma.OutboxJobCreateManyInput[] {
    return [
      {
        claimId,
        kind: 'CLAIM_INVITE',
        dedupeKey: `claim-invite:${claimId}`,
        state: 'PENDING',
      },
      {
        claimId,
        kind: 'CLAIM_REFUND',
        dedupeKey: `claim-refund:${claimId}`,
        state: 'PENDING',
        nextAttemptAt: expiry,
      },
    ];
  }

  constructor(
    private readonly sessions: SessionService,
    private readonly funds: FundsService,
  ) {}

  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  private present(claim: Claim) {
    const awaitingDeposit =
      claim.state === 'AWAITING_DEPOSIT' &&
      claim.preparationExpiresAt.getTime() > Date.now();
    return {
      id: claim.id,
      state:
        claim.state === 'AWAITING_DEPOSIT' && !awaitingDeposit
          ? 'EXPIRED'
          : claim.state,
      chainId: claim.chainId,
      escrow: claim.escrowAddress,
      token: claim.tokenAddress,
      payer: claim.payerAddress,
      amountUnits: claim.amountUnits.toString(),
      expiry: claim.expiry?.toISOString() ?? null,
      depositTxHash: claim.depositTxHash,
      plan: awaitingDeposit
        ? {
            approve: {
              chainId: claim.chainId,
              from: claim.payerAddress,
              to: claim.tokenAddress,
              value: '0',
              data: encodeFunctionData({
                abi: tokenAbi,
                functionName: 'approve',
                args: [
                  claim.escrowAddress as Address,
                  BigInt(claim.amountUnits.toString()),
                ],
              }),
            },
            deposit: {
              chainId: claim.chainId,
              from: claim.payerAddress,
              to: claim.escrowAddress,
              value: '0',
              data: encodeFunctionData({
                abi: escrowAbi,
                functionName: 'deposit',
                args: [
                  claim.id as `0x${string}`,
                  claim.identityCommitment as `0x${string}`,
                  BigInt(claim.amountUnits.toString()),
                ],
              }),
            },
          }
        : null,
    };
  }

  private async projectOpenClaim(tx: Prisma.TransactionClient, claim: Claim) {
    if (
      claim.state !== 'OPEN' ||
      !claim.expiry ||
      !claim.depositTxHash ||
      claim.depositBlockNumber === null ||
      !claim.depositBlockHash
    ) {
      throw new Error('Verified claim deposit is incomplete');
    }
    const payment = await tx.paymentIntent.upsert({
      where: { claimId: claim.id },
      create: {
        claimId: claim.id,
        payerId: claim.payerId,
        chainId: claim.chainId,
        tokenAddress: claim.tokenAddress,
        payerAddress: claim.payerAddress,
        recipientAddress: claim.escrowAddress,
        amountUnits: claim.amountUnits,
        preparedAtBlock: claim.preparedAtBlock,
        kind: 'CLAIM',
        state: 'OPEN',
        idempotencyKey: null,
        requestHash: claim.requestHash,
        authorizationExpiresAt: claim.expiry,
      },
      update: {
        state: 'OPEN',
        authorizationExpiresAt: claim.expiry,
      },
    });
    const existing = await tx.transactionAttempt.findUnique({
      where: {
        chainId_txHash: {
          chainId: claim.chainId,
          txHash: claim.depositTxHash,
        },
      },
    });
    if (existing && existing.intentId !== payment.id) {
      throw new ConflictException(
        'Claim deposit already belongs to another payment',
      );
    }
    if (!existing) {
      await tx.transactionAttempt.create({
        data: {
          intentId: payment.id,
          operationIndex: 0,
          chainId: claim.chainId,
          txHash: claim.depositTxHash,
          state: 'CONFIRMED',
          idempotencyKey: `claim-deposit:${claim.id}`,
          requestHash: claim.requestHash,
          confirmedAt: new Date(),
          blockNumber: claim.depositBlockNumber,
          blockHash: claim.depositBlockHash,
        },
      });
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
      throw new BadRequestException('Invalid claim');
    }
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).sort().join(',') !== 'amountUnits,recipientEmail' ||
      typeof body.recipientEmail !== 'string' ||
      body.recipientEmail.length > 254 ||
      typeof body.amountUnits !== 'string' ||
      !/^[1-9][0-9]{0,77}$/.test(body.amountUnits) ||
      BigInt(body.amountUnits) > (1n << 256n) - 1n
    ) {
      throw new BadRequestException('Invalid claim');
    }
    let email: string;
    try {
      email = normalizeEmail(body.recipientEmail);
    } catch {
      throw new BadRequestException('Invalid email');
    }
    const amount = BigInt(body.amountUnits);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          recipientEmail: email,
          amountUnits: body.amountUnits,
        }),
      )
      .digest('hex');
    const payer = await this.sessions.sync(identityToken);
    if (!payer.handle)
      throw new ConflictException('Handle required before sending');
    const existing = await this.db.claim.findUnique({
      where: { payerId_idempotencyKey: { payerId: payer.id, idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictException('Idempotency-Key already used');
      return this.present(existing);
    }
    const escrowAddress = process.env.CLAIM_ESCROW_ADDRESS?.toLowerCase();
    const rpcUrl = process.env.RPC_URL;
    if (!escrowAddress || !isAddress(escrowAddress) || !rpcUrl) {
      throw new ServiceUnavailableException('Claim escrow is not configured');
    }
    let lookupSecret: Buffer;
    let encryptionSecret: Buffer;
    try {
      lookupSecret = readIdentityKey(process.env.IDENTITY_LOOKUP_HMAC_KEY);
      encryptionSecret = readIdentityKey(process.env.IDENTITY_ENCRYPTION_KEY);
    } catch {
      throw new ServiceUnavailableException(
        'Claim identity storage is not configured',
      );
    }
    const lookupKey = identityKey(email, lookupSecret);
    const payerEmail = await this.db.identity.findFirst({
      where: { userId: payer.id, kind: 'email' },
      select: { lookupKey: true },
    });
    if (payerEmail?.lookupKey === lookupKey)
      throw new BadRequestException('Cannot claim your own payment');

    const balance = await this.funds.readBalance(payer.account);
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    try {
      const escrowToken = await client.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'token',
        blockNumber: BigInt(balance.blockNumber),
      });
      if (escrowToken.toLowerCase() !== balance.token.toLowerCase()) {
        throw new Error('Wrong escrow token');
      }
    } catch {
      throw new ServiceUnavailableException('Claim escrow is unavailable');
    }

    const { claimId, secret } = newClaimBinding();
    const inviteToken = randomBytes(32).toString('base64url');
    const commitment = claimIdentityCommitment(claimId, email, secret);
    const encryptedRecipientEmail = Uint8Array.from(
      encryptIdentity(email, encryptionSecret),
    );
    const encryptedBindingSecret = Uint8Array.from(
      encryptIdentity(secret, encryptionSecret),
    );
    const encryptedInviteToken = Uint8Array.from(
      encryptIdentity(inviteToken, encryptionSecret),
    );
    const inviteTokenHash = createHash('sha256')
      .update(inviteToken)
      .digest('hex');

    const claim = await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${payer.id}::uuid FOR UPDATE`;
        const replay = await tx.claim.findUnique({
          where: {
            payerId_idempotencyKey: { payerId: payer.id, idempotencyKey },
          },
        });
        if (replay) {
          if (replay.requestHash !== requestHash)
            throw new ConflictException('Idempotency-Key already used');
          return replay;
        }
        const direct = await tx.paymentIntent.findMany({
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
        const claims = await tx.claim.findMany({
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
        const reserved = [...direct, ...claims].reduce(
          (sum, item) => sum + BigInt(item.amountUnits.toString()),
          0n,
        );
        if (amount + reserved > BigInt(balance.balanceUnits)) {
          throw new UnprocessableEntityException(
            'Insufficient available funds',
          );
        }
        return tx.claim.create({
          data: {
            id: claimId,
            payerId: payer.id,
            chainId: balance.chainId,
            escrowAddress,
            tokenAddress: balance.token.toLowerCase(),
            payerAddress: payer.account.address,
            amountUnits: body.amountUnits as string,
            identityLookupKey: lookupKey,
            identityCommitment: commitment,
            encryptedRecipientEmail,
            encryptedBindingSecret,
            inviteTokenHash,
            encryptedInviteToken,
            preparedAtBlock: BigInt(balance.blockNumber),
            preparationExpiresAt: new Date(Date.now() + 600_000),
            state: 'AWAITING_DEPOSIT',
            idempotencyKey,
            requestHash,
          },
        });
      },
      { timeout: 15_000 },
    );
    return this.present(claim);
  }

  async get(identityToken: string | undefined, id: string) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new NotFoundException();
    const payer = await this.sessions.sync(identityToken);
    const claim = await this.db.claim.findFirst({
      where: { id, payerId: payer.id },
    });
    if (!claim) throw new NotFoundException();
    const refreshed = await this.refreshDeposit(claim);
    if (!['OPEN', 'CLAIMED', 'REFUNDED'].includes(refreshed.state)) {
      return this.present(refreshed);
    }
    const { onchain } = await this.readOnchainClaim(refreshed);
    const state =
      onchain[4] === 2 ? 'CLAIMED' : onchain[4] === 3 ? 'REFUNDED' : 'OPEN';
    if (state === refreshed.state) return this.present(refreshed);
    await this.db.claim.updateMany({
      where: { id, state: refreshed.state },
      data: { state },
    });
    return this.present(
      await this.db.claim.findUniqueOrThrow({ where: { id } }),
    );
  }

  private async observeDeposit(claim: Claim, hash: Hex) {
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) throw new ServiceUnavailableException('RPC is not configured');
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    try {
      if ((await client.getChainId()) !== claim.chainId) {
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
        abi: escrowAbi,
        functionName: 'deposit',
        args: [
          claim.id as Hex,
          claim.identityCommitment as Hex,
          BigInt(claim.amountUnits.toString()),
        ],
      });
      if (
        transaction.from.toLowerCase() !== claim.payerAddress ||
        transaction.to?.toLowerCase() !== claim.escrowAddress ||
        transaction.input.toLowerCase() !== expectedData.toLowerCase() ||
        transaction.value !== 0n
      ) {
        throw new ConflictException('Transaction does not match claim deposit');
      }
      const receipt = await client
        .getTransactionReceipt({ hash })
        .catch((error: unknown) => {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        });
      if (!receipt) return { state: 'SUBMITTED' };
      if (receipt.blockNumber <= claim.preparedAtBlock) {
        throw new ConflictException('Transaction predates claim');
      }
      if (receipt.status !== 'success') {
        return {
          state: 'FAILED',
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        };
      }
      const deposits = parseEventLogs({
        abi: escrowAbi,
        eventName: 'ClaimDeposited',
        logs: receipt.logs,
      });
      const funded = deposits.find(
        (log) =>
          log.address.toLowerCase() === claim.escrowAddress &&
          log.args.claimId === claim.id &&
          log.args.payer?.toLowerCase() === claim.payerAddress &&
          log.args.identityCommitment === claim.identityCommitment &&
          log.args.amount === BigInt(claim.amountUnits.toString()),
      );
      const transfers = parseEventLogs({
        abi: tokenAbi,
        eventName: 'Transfer',
        logs: receipt.logs,
      });
      const transferred = transfers.some(
        (log) =>
          log.address.toLowerCase() === claim.tokenAddress &&
          log.args.from?.toLowerCase() === claim.payerAddress &&
          log.args.to?.toLowerCase() === claim.escrowAddress &&
          log.args.value === BigInt(claim.amountUnits.toString()),
      );
      if (!funded || !transferred) {
        throw new ConflictException('Claim deposit events do not match');
      }
      const expiry = new Date(Number(funded.args.expiry) * 1000);
      if (!Number.isFinite(expiry.getTime())) {
        throw new ConflictException('Invalid claim expiry');
      }
      return {
        state: 'OPEN',
        expiry,
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
        'Claim deposit verification unavailable',
      );
    }
  }

  private async refreshDeposit(claim: Claim): Promise<Claim> {
    if (claim.state === 'CLAIMED' || claim.state === 'REFUNDED') return claim;
    if (!claim.depositTxHash) return claim;
    const observed = await this.observeDeposit(
      claim,
      claim.depositTxHash as Hex,
    );
    if (
      observed.state === claim.state &&
      (observed.blockHash ?? null) === claim.depositBlockHash &&
      (observed.expiry?.getTime() ?? null) === (claim.expiry?.getTime() ?? null)
    ) {
      if (observed.state === 'OPEN') {
        if (!observed.expiry) throw new Error('Verified expiry missing');
        await this.db.$transaction(async (tx) => {
          await tx.outboxJob.createMany({
            data: this.jobsForOpenClaim(claim.id, observed.expiry),
            skipDuplicates: true,
          });
          await this.projectOpenClaim(tx, claim);
        });
      }
      return claim;
    }
    return this.db.$transaction(async (tx) => {
      const updated = await tx.claim.update({
        where: { id: claim.id },
        data: {
          state: observed.state,
          expiry: observed.expiry ?? null,
          depositBlockNumber: observed.blockNumber ?? null,
          depositBlockHash: observed.blockHash ?? null,
        },
      });
      if (observed.state === 'OPEN') {
        if (!observed.expiry) throw new Error('Verified expiry missing');
        await tx.outboxJob.createMany({
          data: this.jobsForOpenClaim(claim.id, observed.expiry),
          skipDuplicates: true,
        });
        await this.projectOpenClaim(tx, updated);
      }
      return updated;
    });
  }

  async registerDeposit(
    identityToken: string | undefined,
    id: string,
    idempotencyKey: string | undefined,
    input: unknown,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new NotFoundException();
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).join(',') !== 'txHash'
    ) {
      throw new BadRequestException('Invalid claim deposit');
    }
    const rawHash = (input as { txHash?: unknown }).txHash;
    if (typeof rawHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
      throw new BadRequestException('Invalid transaction hash');
    }
    const hash = rawHash.toLowerCase() as Hex;
    const requestHash = createHash('sha256').update(hash).digest('hex');
    const payer = await this.sessions.sync(identityToken);
    const claim = await this.db.claim.findFirst({
      where: { id, payerId: payer.id },
    });
    if (!claim) throw new NotFoundException();
    if (
      claim.depositSubmissionKey === idempotencyKey &&
      claim.depositSubmissionHash !== requestHash
    ) {
      throw new ConflictException('Idempotency-Key already used');
    }
    if (claim.depositTxHash === hash)
      return this.present(await this.refreshDeposit(claim));
    if (claim.depositTxHash && claim.state !== 'FAILED') {
      throw new ConflictException('Claim deposit already submitted');
    }
    const observed = await this.observeDeposit(claim, hash);
    try {
      const updated = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "claims" WHERE "id" = ${id} FOR UPDATE`;
        const current = await tx.claim.findUniqueOrThrow({ where: { id } });
        if (current.state === 'CLAIMED' || current.state === 'REFUNDED') {
          if (current.depositTxHash === hash) return current;
          throw new ConflictException('Claim is closed');
        }
        if (
          current.depositSubmissionKey === idempotencyKey &&
          current.depositSubmissionHash !== requestHash
        ) {
          throw new ConflictException('Idempotency-Key already used');
        }
        if (
          current.depositTxHash &&
          current.depositTxHash !== hash &&
          current.state !== 'FAILED'
        ) {
          throw new ConflictException('Claim deposit already submitted');
        }
        const saved = await tx.claim.update({
          where: { id },
          data: {
            depositTxHash: hash,
            depositSubmissionKey: idempotencyKey,
            depositSubmissionHash: requestHash,
            state: observed.state,
            expiry: observed.expiry ?? null,
            depositBlockNumber: observed.blockNumber ?? null,
            depositBlockHash: observed.blockHash ?? null,
          },
        });
        if (observed.state === 'OPEN') {
          if (!observed.expiry) throw new Error('Verified expiry missing');
          await tx.outboxJob.createMany({
            data: this.jobsForOpenClaim(id, observed.expiry),
            skipDuplicates: true,
          });
          await this.projectOpenClaim(tx, saved);
        }
        return saved;
      });
      return this.present(updated);
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

  private async readOnchainClaim(claim: Claim) {
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) throw new ServiceUnavailableException('RPC is not configured');
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    try {
      if ((await client.getChainId()) !== claim.chainId)
        throw new Error('Wrong chain');
      const block = await client.getBlock();
      const onchain = await client.readContract({
        address: claim.escrowAddress as Address,
        abi: escrowAbi,
        functionName: 'claims',
        args: [claim.id as Hex],
        blockNumber: block.number,
      });
      if (
        onchain[0].toLowerCase() !== claim.payerAddress ||
        onchain[1] !== BigInt(claim.amountUnits.toString()) ||
        onchain[3] !== claim.identityCommitment ||
        onchain[2] * 1000n !== BigInt(claim.expiry?.getTime() ?? 0) ||
        onchain[4] < 1 ||
        onchain[4] > 3
      ) {
        throw new NotFoundException('Invitation unavailable');
      }
      return { client, block, onchain };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Claim state is unavailable');
    }
  }

  private async verifiedInvite(identityToken: string, inviteToken: string) {
    const recipient = await this.sessions.sync(identityToken);
    const tokenHash = createHash('sha256').update(inviteToken).digest('hex');
    const claim = await this.db.claim.findUnique({
      where: { inviteTokenHash: tokenHash },
      include: { payer: { select: { handle: true } } },
    });
    if (!claim) throw new NotFoundException('Invitation unavailable');
    const matchingIdentity = await this.db.identity.findUnique({
      where: {
        kind_lookupKey: { kind: 'email', lookupKey: claim.identityLookupKey },
      },
      select: { userId: true },
    });
    if (
      matchingIdentity?.userId !== recipient.id ||
      recipient.account.chainId !== claim.chainId
    ) {
      throw new NotFoundException('Invitation unavailable');
    }
    return { recipient, claim };
  }

  async resolveLink(identityToken: string | undefined, input: unknown) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).join(',') !== 'token' ||
      typeof (input as { token?: unknown }).token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test((input as { token: string }).token)
    ) {
      throw new BadRequestException('Invalid invitation');
    }
    if (!identityToken) return { requiresVerification: true };
    const { claim } = await this.verifiedInvite(
      identityToken,
      (input as { token: string }).token,
    );
    const { block, onchain } = await this.readOnchainClaim(claim);
    return {
      id: claim.id,
      chainId: claim.chainId,
      escrow: claim.escrowAddress,
      payerHandle: claim.payer.handle,
      amountUnits: claim.amountUnits.toString(),
      token: claim.tokenAddress,
      expiry: claim.expiry?.toISOString(),
      state:
        onchain[4] === 1
          ? block.timestamp < onchain[2]
            ? 'OPEN'
            : 'REFUNDABLE'
          : onchain[4] === 2
            ? 'CLAIMED'
            : 'REFUNDED',
    };
  }

  async authorize(
    identityToken: string | undefined,
    id: string,
    idempotencyKey: string | undefined,
    input: unknown,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new NotFoundException();
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).join(',') !== 'inviteToken' ||
      typeof (input as { inviteToken?: unknown }).inviteToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(
        (input as { inviteToken: string }).inviteToken,
      )
    ) {
      throw new BadRequestException('Invalid authorization request');
    }
    const { recipient, claim } = await this.verifiedInvite(
      identityToken,
      (input as { inviteToken: string }).inviteToken,
    );
    if (claim.id !== id) throw new NotFoundException('Invitation unavailable');
    const { client, block, onchain } = await this.readOnchainClaim(claim);
    if (onchain[4] !== 1 || block.timestamp >= onchain[2]) {
      throw new ConflictException('Claim is no longer available');
    }
    let nonce: bigint;
    let signerEpoch: bigint;
    let signerAddress: Address;
    let tokenAddress: Address;
    try {
      [nonce, signerEpoch, signerAddress, tokenAddress] = await Promise.all([
        client.readContract({
          address: claim.escrowAddress as Address,
          abi: escrowAbi,
          functionName: 'nonces',
          args: [claim.id as Hex],
          blockNumber: block.number,
        }),
        client.readContract({
          address: claim.escrowAddress as Address,
          abi: escrowAbi,
          functionName: 'signerEpoch',
          blockNumber: block.number,
        }),
        client.readContract({
          address: claim.escrowAddress as Address,
          abi: escrowAbi,
          functionName: 'identitySigner',
          blockNumber: block.number,
        }),
        client.readContract({
          address: claim.escrowAddress as Address,
          abi: escrowAbi,
          functionName: 'token',
          blockNumber: block.number,
        }),
      ]);
    } catch {
      throw new ServiceUnavailableException(
        'Claim authorization state is unavailable',
      );
    }
    if (tokenAddress.toLowerCase() !== claim.tokenAddress) {
      throw new ServiceUnavailableException('Claim token changed');
    }
    const signerKey = process.env.CLAIM_IDENTITY_SIGNER_PRIVATE_KEY;
    if (!signerKey || !/^0x[0-9a-fA-F]{64}$/.test(signerKey)) {
      throw new ServiceUnavailableException('Claim signer is not configured');
    }
    const signer = privateKeyToAccount(signerKey as Hex);
    if (signer.address.toLowerCase() !== signerAddress.toLowerCase()) {
      throw new ServiceUnavailableException(
        'Claim signer does not match escrow',
      );
    }
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          claimId: claim.id,
          inviteTokenHash: claim.inviteTokenHash,
          recipient: recipient.account.address,
        }),
      )
      .digest('hex');
    const existing = await this.db.claimAuthorization.findUnique({
      where: { claimId_idempotencyKey: { claimId: claim.id, idempotencyKey } },
    });
    const current = Number(block.timestamp) * 1000;
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException('Idempotency-Key already used');
      }
      if (
        existing.deadline.getTime() <= current ||
        BigInt(existing.nonce.toString()) !== nonce ||
        existing.signerEpoch !== signerEpoch
      ) {
        throw new ConflictException('Authorization expired; use a new key');
      }
      return this.presentAuthorization(
        claim,
        recipient.account.address as Address,
        existing,
      );
    }
    const recent = await this.db.claimAuthorization.count({
      where: {
        claimId: claim.id,
        createdAt: { gte: new Date(Date.now() - 600_000) },
      },
    });
    if (recent >= 5) {
      throw new HttpException(
        'Authorization limit reached',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const deadline =
      block.timestamp + 300n < onchain[2]
        ? block.timestamp + 300n
        : onchain[2] - 1n;
    if (deadline <= block.timestamp) {
      throw new ConflictException('Claim is too close to expiry');
    }
    const message = {
      claimId: claim.id as Hex,
      identityCommitment: claim.identityCommitment as Hex,
      token: claim.tokenAddress as Address,
      amount: BigInt(claim.amountUnits.toString()),
      recipient: recipient.account.address as Address,
      nonce,
      deadline,
      signerEpoch,
    };
    const signature = await signer.signTypedData(
      claimAuthorizationTypedData(
        claim.chainId,
        claim.escrowAddress as Address,
        message,
      ),
    );
    const digest = claimAuthorizationDigest(
      claim.chainId,
      claim.escrowAddress as Address,
      message,
    );
    try {
      const created = await this.db.claimAuthorization.create({
        data: {
          claimId: claim.id,
          nonce: nonce.toString(),
          recipientAddress: recipient.account.address,
          deadline: new Date(Number(deadline) * 1000),
          signerEpoch,
          digest,
          identitySignature: Uint8Array.from(
            Buffer.from(signature.slice(2), 'hex'),
          ),
          idempotencyKey,
          requestHash,
          state: 'ISSUED',
        },
      });
      return this.presentAuthorization(
        claim,
        recipient.account.address as Address,
        created,
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.db.claimAuthorization.findUnique({
          where: {
            claimId_idempotencyKey: { claimId: claim.id, idempotencyKey },
          },
        });
        if (replay?.requestHash === requestHash) {
          return this.presentAuthorization(
            claim,
            recipient.account.address as Address,
            replay,
          );
        }
        throw new ConflictException('Authorization already issued');
      }
      throw error;
    }
  }

  private presentAuthorization(
    claim: Claim,
    recipientAddress: Address,
    authorization: {
      nonce: { toString(): string };
      deadline: Date;
      signerEpoch: bigint;
      digest: string;
      identitySignature: Uint8Array;
    },
  ) {
    const digest = authorization.digest as Hex;
    return {
      authorization: {
        claimId: claim.id,
        identityCommitment: claim.identityCommitment,
        token: claim.tokenAddress,
        amount: claim.amountUnits.toString(),
        recipient: recipientAddress,
        nonce: authorization.nonce.toString(),
        deadline: Math.floor(
          authorization.deadline.getTime() / 1000,
        ).toString(),
        signerEpoch: authorization.signerEpoch.toString(),
      },
      authorizationDigest: digest,
      identitySignature: toHex(authorization.identitySignature),
      acceptanceDigest: claimAcceptanceDigest(
        claim.chainId,
        claim.escrowAddress as Address,
        digest,
      ),
      acceptanceTypedData: claimAcceptanceTypedData(
        claim.chainId,
        claim.escrowAddress as Address,
        digest,
      ),
    };
  }

  async submit(
    identityToken: string | undefined,
    id: string,
    idempotencyKey: string | undefined,
    input: unknown,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new NotFoundException();
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Invalid claim acceptance');
    }
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).sort().join(',') !==
        'authorizationDigest,inviteToken,recipientSignature' ||
      typeof body.inviteToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.inviteToken) ||
      typeof body.authorizationDigest !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(body.authorizationDigest) ||
      typeof body.recipientSignature !== 'string' ||
      body.recipientSignature.length > 4098 ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(body.recipientSignature)
    ) {
      throw new BadRequestException('Invalid claim acceptance');
    }
    const { recipient, claim } = await this.verifiedInvite(
      identityToken,
      body.inviteToken,
    );
    if (claim.id !== id) throw new NotFoundException('Invitation unavailable');
    const authorization = await this.db.claimAuthorization.findFirst({
      where: { claimId: id, digest: body.authorizationDigest.toLowerCase() },
    });
    if (
      !authorization ||
      authorization.recipientAddress !== recipient.account.address.toLowerCase()
    ) {
      throw new NotFoundException('Authorization unavailable');
    }
    const signature = body.recipientSignature.toLowerCase() as Hex;
    const existingJob = await this.db.outboxJob.findUnique({
      where: { dedupeKey: `claim-relay:${id}` },
    });
    if (existingJob && existingJob.state !== 'CANCELED') {
      if (
        toHex(authorization.recipientSignature ?? new Uint8Array()) !==
        signature
      ) {
        throw new ConflictException('Claim already submitted');
      }
      return { id, state: existingJob.state, txHash: existingJob.txHash };
    }
    const { client, block, onchain } = await this.readOnchainClaim(claim);
    if (onchain[4] !== 1 || block.timestamp >= onchain[2]) {
      throw new ConflictException('Claim is no longer available');
    }
    const [nonce, signerEpoch] = await Promise.all([
      client.readContract({
        address: claim.escrowAddress as Address,
        abi: escrowAbi,
        functionName: 'nonces',
        args: [claim.id as Hex],
        blockNumber: block.number,
      }),
      client.readContract({
        address: claim.escrowAddress as Address,
        abi: escrowAbi,
        functionName: 'signerEpoch',
        blockNumber: block.number,
      }),
    ]);
    if (
      BigInt(authorization.nonce.toString()) !== nonce ||
      authorization.signerEpoch !== signerEpoch ||
      BigInt(Math.floor(authorization.deadline.getTime() / 1000)) <
        block.timestamp
    ) {
      throw new ConflictException('Authorization expired');
    }
    const valid = await client.verifyTypedData({
      address: recipient.account.address as Address,
      ...claimAcceptanceTypedData(
        claim.chainId,
        claim.escrowAddress as Address,
        authorization.digest as Hex,
      ),
      signature,
      blockNumber: block.number,
    });
    if (!valid) throw new BadRequestException('Invalid recipient signature');
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "claims" WHERE "id" = ${id} FOR UPDATE`;
      const existing = await tx.outboxJob.findUnique({
        where: { dedupeKey: `claim-relay:${id}` },
      });
      if (existing?.state === 'CANCELED' && authorization.state === 'ISSUED') {
        await tx.claimAuthorization.update({
          where: { id: authorization.id },
          data: {
            state: 'ACCEPTED',
            recipientSignature: Uint8Array.from(
              Buffer.from(signature.slice(2), 'hex'),
            ),
          },
        });
        await tx.outboxJob.update({
          where: { id: existing.id },
          data: {
            state: 'PENDING',
            txHash: null,
            leaseUntil: null,
            nextAttemptAt: new Date(),
          },
        });
        return { id, state: 'PENDING', txHash: null };
      }
      if (existing) {
        const accepted = await tx.claimAuthorization.findFirst({
          where: {
            claimId: id,
            state: { in: ['ACCEPTED', 'SUBMITTED', 'CONSUMED'] },
          },
        });
        if (
          accepted?.id !== authorization.id ||
          toHex(accepted.recipientSignature ?? new Uint8Array()) !== signature
        ) {
          throw new ConflictException('Claim already submitted');
        }
        return { id, state: existing.state, txHash: existing.txHash };
      }
      await tx.claimAuthorization.update({
        where: { id: authorization.id },
        data: {
          state: 'ACCEPTED',
          recipientSignature: Uint8Array.from(
            Buffer.from(signature.slice(2), 'hex'),
          ),
        },
      });
      await tx.outboxJob.create({
        data: {
          claimId: id,
          kind: 'CLAIM_RELAY',
          dedupeKey: `claim-relay:${id}`,
          state: 'PENDING',
        },
      });
      return { id, state: 'PENDING', txHash: null };
    });
  }

  async requestRefund(
    identityToken: string | undefined,
    id: string,
    idempotencyKey: string | undefined,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new NotFoundException();
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    const payer = await this.sessions.sync(identityToken);
    const claim = await this.db.claim.findFirst({
      where: { id, payerId: payer.id },
    });
    if (!claim) throw new NotFoundException();
    const { block, onchain } = await this.readOnchainClaim(claim);
    if (onchain[4] === 2) return { id, state: 'CLAIMED' };
    if (onchain[4] === 3) return { id, state: 'REFUNDED' };
    if (block.timestamp < onchain[2]) {
      throw new ConflictException('Claim is not yet refundable');
    }
    await this.db.outboxJob.createMany({
      data: {
        claimId: id,
        kind: 'CLAIM_REFUND',
        dedupeKey: `claim-refund:${id}`,
        state: 'PENDING',
      },
      skipDuplicates: true,
    });
    await this.db.outboxJob.updateMany({
      where: { dedupeKey: `claim-refund:${id}`, state: 'PENDING' },
      data: { nextAttemptAt: new Date() },
    });
    return { id, state: 'QUEUED' };
  }

  async resendInvite(
    identityToken: string | undefined,
    id: string,
    idempotencyKey: string | undefined,
  ) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new NotFoundException();
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    const payer = await this.sessions.sync(identityToken);
    const claim = await this.db.claim.findFirst({
      where: { id, payerId: payer.id },
    });
    if (!claim) throw new NotFoundException();
    const { block, onchain } = await this.readOnchainClaim(claim);
    if (onchain[4] !== 1 || block.timestamp >= onchain[2]) {
      throw new ConflictException('Claim invitation is no longer active');
    }
    const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
    const dedupeKey = `resend:${id}:${keyHash.slice(0, 32)}`;
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "claims" WHERE "id" = ${id} FOR UPDATE`;
      const replay = await tx.outboxJob.findUnique({ where: { dedupeKey } });
      if (replay) return { id, state: replay.state };
      const original = await tx.outboxJob.findUnique({
        where: { dedupeKey: `claim-invite:${id}` },
      });
      if (!original) throw new ConflictException('Invitation is not ready');
      if (original.state !== 'SENT') return { id, state: original.state };
      const since = new Date(Date.now() - 86_400_000);
      const resends = await tx.outboxJob.findMany({
        where: {
          claimId: id,
          kind: 'CLAIM_INVITE',
          dedupeKey: { startsWith: `resend:${id}:` },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (
        resends.length >= 5 ||
        (resends[0] && resends[0].createdAt.getTime() > Date.now() - 60_000)
      ) {
        throw new HttpException(
          'Invitation resend limit reached',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await tx.outboxJob.create({
        data: {
          claimId: id,
          kind: 'CLAIM_INVITE',
          dedupeKey,
          state: 'PENDING',
        },
      });
      return { id, state: 'PENDING' };
    });
  }
}
