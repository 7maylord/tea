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
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import {
  decryptIdentity,
  readIdentityKey,
} from '../src/identity/identity.crypto';
import { SessionService } from '../src/identity/session.service';

const depositAbi = parseAbi([
  'function deposit(bytes32 claimId, bytes32 commitment, uint256 amount)',
]);

describe('claim preparation (Postgres and Anvil)', () => {
  let app: INestApplication<App>;
  const db = new PrismaClient();
  let payerId: string;
  let otherId: string;
  const payerAddress = `0x${randomBytes(20).toString('hex')}`;

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
            account: { chainId: 31337, address: payerAddress },
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
  });

  afterAll(async () => {
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
  });
});
