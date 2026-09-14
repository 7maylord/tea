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
import { Claim, Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  parseAbi,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import { FundsService } from '../funds/funds.service';
import { SessionService } from '../identity/session.service';
import {
  encryptIdentity,
  identityKey,
  normalizeEmail,
  readIdentityKey,
} from '../identity/identity.crypto';
import { claimIdentityCommitment, newClaimBinding } from './claim.crypto';

const escrowAbi = parseAbi([
  'function token() view returns (address)',
  'function deposit(bytes32 claimId, bytes32 commitment, uint256 amount)',
  'event ClaimDeposited(bytes32 indexed claimId, address indexed payer, bytes32 indexed identityCommitment, uint256 amount, uint64 expiry)',
]);

@Injectable()
export class ClaimsService implements OnModuleDestroy {
  private readonly db = new PrismaClient();

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
                abi: erc20Abi,
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
    return this.present(await this.refreshDeposit(claim));
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
        abi: erc20Abi,
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
      return claim;
    }
    return this.db.claim.update({
      where: { id: claim.id },
      data: {
        state: observed.state,
        expiry: observed.expiry ?? null,
        depositBlockNumber: observed.blockNumber ?? null,
        depositBlockHash: observed.blockHash ?? null,
      },
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
        return tx.claim.update({
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
}
