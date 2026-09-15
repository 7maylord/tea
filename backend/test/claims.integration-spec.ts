import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Address,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import {
  claimAcceptanceDigest,
  claimAuthorizationDigest,
} from '../src/claims/claim.typed-data';
import {
  decryptIdentity,
  encryptIdentity,
  readIdentityKey,
} from '../src/identity/identity.crypto';
import { SessionService } from '../src/identity/session.service';

const depositAbi = parseAbi([
  'function deposit(bytes32 claimId, bytes32 commitment, uint256 amount)',
]);
const signatureAbi = parseAbi([
  'function signerEpoch() view returns (uint64)',
  'function authorizationDigest((bytes32 claimId,bytes32 identityCommitment,address token,uint256 amount,address recipient,uint256 nonce,uint64 deadline,uint64 signerEpoch) authorization) view returns (bytes32)',
  'function acceptanceDigest(bytes32 signedAuthorizationDigest) view returns (bytes32)',
]);
const payerAccount = privateKeyToAccount(
  `0x${randomBytes(32).toString('hex')}`,
);
const recipientAddress = `0x${randomBytes(20).toString('hex')}`;

describe('claim preparation (Postgres and Anvil)', () => {
  let app: INestApplication<App>;
  const db = new PrismaClient();
  let payerId: string;
  let otherId: string;
  const payerAddress = payerAccount.address.toLowerCase();

  beforeAll(async () => {
    process.env.CHAIN_ID = '31337';
    const payer = await db.user.create({
      data: {
        privyDid: `did:privy:${randomUUID()}`,
        handle: `u_${randomBytes(6).toString('hex')}`,
      },
    });
    const other = await db.user.create({
      data: { privyDid: `did:privy:${randomUUID()}` },
    });
    payerId = payer.id;
    otherId = other.id;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SessionService)
      .useValue({
        sync: jest.fn((token: string) =>
          Promise.resolve({
            id: token === 'other' ? otherId : payerId,
            handle: payer.handle,
            account: {
              chainId: 31337,
              address: token === 'other' ? recipientAddress : payerAddress,
            },
          }),
        ),
        recipientSnapshot: jest.fn(() =>
          Promise.resolve({
            userId: otherId,
            destination: `0x${'11'.repeat(20)}`,
          }),
        ),
      })
      .compile();
    app = module.createNestApplication();
    await app.init();

    const wallet = createWalletClient({
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const [sender] = await wallet.getAddresses();
    const hash = await wallet.writeContract({
      account: sender,
      address: process.env.SETTLEMENT_TOKEN as Address,
      abi: parseAbi(['function mint(address recipient, uint256 amount)']),
      functionName: 'mint',
      args: [payerAddress, 20_000_000n],
    });
    await createPublicClient({
      transport: http(process.env.RPC_URL),
    }).waitForTransactionReceipt({ hash });
    const gasHash = await wallet.sendTransaction({
      account: sender,
      to: payerAccount.address,
      value: 10n ** 18n,
    });
    await createPublicClient({
      transport: http(process.env.RPC_URL),
    }).waitForTransactionReceipt({ hash: gasHash });
  });

  afterAll(async () => {
    await db.identity.deleteMany({ where: { userId: otherId } });
    await db.claimAuthorization.deleteMany({ where: { claim: { payerId } } });
    await db.claim.deleteMany({ where: { payerId } });
    await db.transactionAttempt.deleteMany({ where: { intent: { payerId } } });
    await db.paymentIntent.deleteMany({ where: { payerId } });
    await db.user.deleteMany({ where: { id: { in: [payerId, otherId] } } });
    await db.$disconnect();
    await app.close();
  });

  it('reserves once and exposes only exact wallet calls', async () => {
    const body = {
      recipientEmail: 'Name+tag@EXAMPLE.COM',
      amountUnits: '15000000',
    };
    await request(app.getHttpServer())
      .post('/v1/claims')
      .send(body)
      .expect(401);
    const created = await request(app.getHttpServer())
      .post('/v1/claims')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'claim-one')
      .send(body)
      .expect(201);
    const claim = created.body as {
      id: `0x${string}`;
      state: string;
      plan: {
        approve: { to: string; data: `0x${string}` };
        deposit: { to: string; data: `0x${string}` };
      };
    };
    expect(claim.id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(claim.state).toBe('AWAITING_DEPOSIT');
    expect(JSON.stringify(claim)).not.toContain('Name+tag');
    expect(claim.plan.approve.to.toLowerCase()).toBe(
      process.env.SETTLEMENT_TOKEN?.toLowerCase(),
    );
    expect(claim.plan.deposit.to.toLowerCase()).toBe(
      process.env.CLAIM_ESCROW_ADDRESS?.toLowerCase(),
    );
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: claim.plan.approve.data,
    });
    expect(approval.functionName).toBe('approve');
    expect(approval.args?.[0]?.toLowerCase()).toBe(
      process.env.CLAIM_ESCROW_ADDRESS?.toLowerCase(),
    );
    expect(approval.args?.[1]).toBe(15_000_000n);
    const deposit = decodeFunctionData({
      abi: depositAbi,
      data: claim.plan.deposit.data,
    });
    expect(deposit.functionName).toBe('deposit');
    expect(deposit.args?.[0]).toBe(claim.id);
    expect(deposit.args?.[2]).toBe(15_000_000n);

    const stored = await db.claim.findUniqueOrThrow({
      where: { id: claim.id },
    });
    expect(stored.identityCommitment).toBe(deposit.args?.[1]);
    expect(
      decryptIdentity(
        stored.encryptedRecipientEmail,
        readIdentityKey(process.env.IDENTITY_ENCRYPTION_KEY),
      ),
    ).toBe('Name+tag@example.com');
    expect(JSON.stringify(claim)).not.toContain(stored.inviteTokenHash);
    expect(JSON.stringify(claim)).not.toContain(stored.identityLookupKey);

    const replay = await request(app.getHttpServer())
      .post('/v1/claims')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'claim-one')
      .send({ ...body, recipientEmail: 'Name+tag@example.com' })
      .expect(201);
    expect((replay.body as { id: string }).id).toBe(claim.id);
    await request(app.getHttpServer())
      .post('/v1/claims')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'claim-one')
      .send({ ...body, amountUnits: '14000000' })
      .expect(409);
    await request(app.getHttpServer())
      .get(`/v1/claims/${claim.id}`)
      .set('privy-id-token', 'other')
      .expect(404);
    await request(app.getHttpServer())
      .post('/v1/claims')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'claim-two')
      .send({ ...body, amountUnits: '6000000' })
      .expect(422);
    await request(app.getHttpServer())
      .post('/v1/payments')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'send-after-claim')
      .send({
        recipientReference: randomBytes(32).toString('base64url'),
        amountUnits: '6000000',
      })
      .expect(422);

    const signer = createWalletClient({
      account: payerAccount,
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const approvalHash = await signer.sendTransaction({
      to: claim.plan.approve.to as Address,
      data: claim.plan.approve.data,
      value: 0n,
    });
    const client = createPublicClient({ transport: http(process.env.RPC_URL) });
    await client.waitForTransactionReceipt({ hash: approvalHash });
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/deposit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'deposit-approval-only')
      .send({ txHash: approvalHash })
      .expect(409);
    const depositHash = await signer.sendTransaction({
      to: claim.plan.deposit.to as Address,
      data: claim.plan.deposit.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: depositHash });
    const confirmed = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/deposit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'deposit-confirmed')
      .send({ txHash: depositHash })
      .expect(201);
    expect((confirmed.body as { state: string }).state).toBe('OPEN');
    expect((confirmed.body as { expiry: string }).expiry).toBeTruthy();
    expect((confirmed.body as { plan: unknown }).plan).toBeNull();
    const again = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/deposit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'deposit-confirmed')
      .send({ txHash: depositHash })
      .expect(201);
    expect((again.body as { state: string }).state).toBe('OPEN');
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/deposit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'deposit-confirmed')
      .send({ txHash: `0x${'22'.repeat(32)}` })
      .expect(409);
    const saved = await db.claim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(saved.depositTxHash).toBe(depositHash);
    expect(saved.depositBlockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(saved.expiry).not.toBeNull();

    const signerEpoch = await client.readContract({
      address: saved.escrowAddress as Address,
      abi: signatureAbi,
      functionName: 'signerEpoch',
    });
    const authorization = {
      claimId: claim.id,
      identityCommitment: saved.identityCommitment as `0x${string}`,
      token: saved.tokenAddress as Address,
      amount: BigInt(saved.amountUnits.toString()),
      recipient: recipientAddress as Address,
      nonce: 0n,
      deadline: BigInt(Math.floor(saved.expiry!.getTime() / 1000) - 1),
      signerEpoch,
    };
    const backendDigest = claimAuthorizationDigest(
      saved.chainId,
      saved.escrowAddress as Address,
      authorization,
    );
    const onchainDigest = await client.readContract({
      address: saved.escrowAddress as Address,
      abi: signatureAbi,
      functionName: 'authorizationDigest',
      args: [authorization],
    });
    expect(backendDigest).toBe(onchainDigest);
    const backendAcceptance = claimAcceptanceDigest(
      saved.chainId,
      saved.escrowAddress as Address,
      backendDigest,
    );
    expect(backendAcceptance).toBe(
      await client.readContract({
        address: saved.escrowAddress as Address,
        abi: signatureAbi,
        functionName: 'acceptanceDigest',
        args: [backendDigest],
      }),
    );

    const encryptionKey = readIdentityKey(process.env.IDENTITY_ENCRYPTION_KEY);
    const inviteToken = decryptIdentity(
      saved.encryptedInviteToken,
      encryptionKey,
    );
    await request(app.getHttpServer())
      .post('/v1/claims/resolve-link')
      .send({ token: inviteToken })
      .expect(201, { requiresVerification: true });
    await request(app.getHttpServer())
      .post('/v1/claims/resolve-link')
      .set('privy-id-token', 'payer')
      .send({ token: inviteToken })
      .expect(404);
    await db.identity.create({
      data: {
        userId: otherId,
        kind: 'email',
        encryptedValue: Uint8Array.from(
          encryptIdentity('Name+tag@example.com', encryptionKey),
        ),
        lookupKey: saved.identityLookupKey,
        verifiedAt: new Date(),
      },
    });
    const invitation = await request(app.getHttpServer())
      .post('/v1/claims/resolve-link')
      .set('privy-id-token', 'other')
      .send({ token: inviteToken })
      .expect(201);
    expect((invitation.body as { id: string }).id).toBe(claim.id);
    expect((invitation.body as { state: string }).state).toBe('OPEN');
    expect(JSON.stringify(invitation.body)).not.toContain(inviteToken);
  });
});
