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
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  parseAbi,
  parseEventLogs,
  toHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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

const escrowAbi = parseAbi([
  'function token() view returns (address)',
  'function deposit(bytes32 claimId, bytes32 commitment, uint256 amount)',
  'function claims(bytes32 claimId) view returns (address payer, uint256 amount, uint64 expiry, bytes32 identityCommitment, uint8 status)',
  'function nonces(bytes32 claimId) view returns (uint256)',
  'function signerEpoch() view returns (uint64)',
  'function identitySigner() view returns (address)',
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
}
