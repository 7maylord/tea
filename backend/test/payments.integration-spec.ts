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
  parseEther,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/identity/session.service';

const payerAccount = privateKeyToAccount(
  `0x${randomBytes(32).toString('hex')}`,
);
const payerAddress = payerAccount.address.toLowerCase();
const recipientAddress = `0x${randomBytes(20).toString('hex')}`;
const reference = randomBytes(32).toString('base64url');

describe('direct payment intents (Postgres and Anvil)', () => {
  let app: INestApplication<App>;
  const db = new PrismaClient();
  let payerId: string;
  let recipientId: string;
  let mintHash: Hex;
  let oldTransferHash: Hex;

  beforeAll(async () => {
    process.env.CHAIN_ID = '31337';
    const payer = await db.user.create({
      data: {
        privyDid: `did:privy:${randomUUID()}`,
        handle: `u_${randomBytes(6).toString('hex')}`,
      },
    });
    const recipient = await db.user.create({
      data: { privyDid: `did:privy:${randomUUID()}` },
    });
    payerId = payer.id;
    recipientId = recipient.id;

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SessionService)
      .useValue({
        sync: jest.fn((token: string) =>
          Promise.resolve({
            id: token === 'other' ? recipientId : payerId,
            handle: payer.handle,
            account: { chainId: 31337, address: payerAddress },
          }),
        ),
        recipientSnapshot: jest.fn(() =>
          Promise.resolve({
            userId: recipientId,
            destination: recipientAddress,
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
      args: [payerAddress, 21_000_000n],
    });
    const client = createPublicClient({ transport: http(process.env.RPC_URL) });
    await client.waitForTransactionReceipt({ hash });
    mintHash = hash;
    const gasHash = await wallet.sendTransaction({
      account: sender,
      to: payerAccount.address,
      value: parseEther('1'),
    });
    await client.waitForTransactionReceipt({ hash: gasHash });
    const senderWallet = createWalletClient({
      account: payerAccount,
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    oldTransferHash = await senderWallet.writeContract({
      address: process.env.SETTLEMENT_TOKEN as Address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipientAddress, 1_000_000n],
    });
    await client.waitForTransactionReceipt({ hash: oldTransferHash });
  });

  afterAll(async () => {
    await db.transactionAttempt.deleteMany({ where: { intent: { payerId } } });
    await db.paymentIntent.deleteMany({ where: { payerId } });
    await db.user.deleteMany({ where: { id: { in: [payerId, recipientId] } } });
    await db.$disconnect();
    await app.close();
  });

  it('reserves once, recovers retries, and verifies the actual transfer', async () => {
    const body = { recipientReference: reference, amountUnits: '15000000' };
    await request(app.getHttpServer())
      .post('/v1/payments')
      .send(body)
      .expect(401);

    const [one, two] = await Promise.all([
      request(app.getHttpServer())
        .post('/v1/payments')
        .set('privy-id-token', 'payer')
        .set('Idempotency-Key', 'payment-one')
        .send(body),
      request(app.getHttpServer())
        .post('/v1/payments')
        .set('privy-id-token', 'payer')
        .set('Idempotency-Key', 'payment-two')
        .send(body),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 422]);
    const accepted = one.status === 201 ? one : two;
    const key = one.status === 201 ? 'payment-one' : 'payment-two';
    const intent = accepted.body as {
      id: string;
      plan: { chainId: number; to: string; data: Hex };
    };
    expect(intent.plan.chainId).toBe(31337);
    expect(intent.plan.to).toBe(process.env.SETTLEMENT_TOKEN?.toLowerCase());
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: intent.plan.data,
    });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args?.[0]?.toLowerCase()).toBe(recipientAddress);
    expect(decoded.args?.[1]).toBe(15_000_000n);

    const replay = await request(app.getHttpServer())
      .post('/v1/payments')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect((replay.body as { id: string }).id).toBe(intent.id);
    await request(app.getHttpServer())
      .post('/v1/payments')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', key)
      .send({ ...body, amountUnits: '1000000' })
      .expect(409);
    await request(app.getHttpServer())
      .get(`/v1/payments/${intent.id}`)
      .set('privy-id-token', 'other')
      .expect(404);
    const recovered = await request(app.getHttpServer())
      .get(`/v1/payments/${intent.id}`)
      .set('privy-id-token', 'payer')
      .expect(200);
    expect((recovered.body as { id: string }).id).toBe(intent.id);
    const [doubleTapOne, doubleTapTwo] = await Promise.all([
      request(app.getHttpServer())
        .post('/v1/payments')
        .set('privy-id-token', 'payer')
        .set('Idempotency-Key', 'payment-three')
        .send({ ...body, amountUnits: '1000000' }),
      request(app.getHttpServer())
        .post('/v1/payments')
        .set('privy-id-token', 'payer')
        .set('Idempotency-Key', 'payment-three')
        .send({ ...body, amountUnits: '1000000' }),
    ]);
    expect([doubleTapOne.status, doubleTapTwo.status]).toEqual([201, 201]);
    expect((doubleTapOne.body as { id: string }).id).toBe(
      (doubleTapTwo.body as { id: string }).id,
    );
    expect(await db.paymentIntent.count({ where: { payerId } })).toBe(2);

    const uncertainId = (doubleTapOne.body as { id: string }).id;
    await request(app.getHttpServer())
      .post(`/v1/payments/${uncertainId}/submission`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'submit-old')
      .send({ txHash: oldTransferHash })
      .expect(409);
    const uncertainHash = `0x${randomBytes(32).toString('hex')}`;
    const uncertain = await request(app.getHttpServer())
      .post(`/v1/payments/${uncertainId}/submission`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'submit-unknown')
      .send({ txHash: uncertainHash })
      .expect(201);
    expect((uncertain.body as { state: string }).state).toBe('RECONCILING');
    const uncertainRecovered = await request(app.getHttpServer())
      .get(`/v1/payments/${uncertainId}`)
      .set('privy-id-token', 'payer')
      .expect(200);
    expect((uncertainRecovered.body as { state: string }).state).toBe(
      'RECONCILING',
    );
    const incomingBeforeConfirmation = await request(app.getHttpServer())
      .get('/v1/activity')
      .set('privy-id-token', 'other')
      .expect(200);
    expect(
      (incomingBeforeConfirmation.body as { items: unknown[] }).items,
    ).toEqual([]);

    await request(app.getHttpServer())
      .post(`/v1/payments/${intent.id}/submission`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'submit-one')
      .send({ txHash: mintHash })
      .expect(409);
    const senderWallet = createWalletClient({
      account: payerAccount,
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const transferHash = await senderWallet.writeContract({
      address: process.env.SETTLEMENT_TOKEN as Address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipientAddress, 15_000_000n],
    });
    const registered = await request(app.getHttpServer())
      .post(`/v1/payments/${intent.id}/submission`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'submit-one')
      .send({ txHash: transferHash })
      .expect(201);
    expect((registered.body as { state: string }).state).toBe('CONFIRMED');
    await request(app.getHttpServer())
      .post(`/v1/payments/${intent.id}/submission`)
      .set('privy-id-token', 'other')
      .set('Idempotency-Key', 'submit-other')
      .send({ txHash: transferHash })
      .expect(404);
    const submittedAgain = await request(app.getHttpServer())
      .post(`/v1/payments/${intent.id}/submission`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'submit-one')
      .send({ txHash: transferHash })
      .expect(201);
    expect((submittedAgain.body as { state: string }).state).toBe('CONFIRMED');
    await request(app.getHttpServer())
      .post(`/v1/payments/${intent.id}/submission`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'submit-one')
      .send({ txHash: oldTransferHash })
      .expect(409);
    const recoveredTransfer = await request(app.getHttpServer())
      .get(`/v1/payments/${intent.id}`)
      .set('privy-id-token', 'payer')
      .expect(200);
    expect((recoveredTransfer.body as { state: string }).state).toBe(
      'CONFIRMED',
    );
    expect(
      await db.transactionAttempt.count({ where: { intentId: intent.id } }),
    ).toBe(1);

    const fourth = await request(app.getHttpServer())
      .post('/v1/payments')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'payment-four')
      .send({ ...body, amountUnits: '4000000' })
      .expect(201);

    await request(app.getHttpServer()).get('/v1/activity').expect(401);
    const outgoing = await request(app.getHttpServer())
      .get('/v1/activity')
      .set('privy-id-token', 'payer')
      .expect(200);
    const outgoingItems = (
      outgoing.body as {
        items: { id: string; state: string; direction: string }[];
        nextCursor: string | null;
      }
    ).items;
    expect(outgoingItems).toHaveLength(3);
    expect(outgoingItems.find((item) => item.id === intent.id)).toMatchObject({
      state: 'CONFIRMED',
      direction: 'OUTGOING',
    });
    const next = await request(app.getHttpServer())
      .get('/v1/activity')
      .query({ cursor: outgoingItems[0].id })
      .set('privy-id-token', 'payer')
      .expect(200);
    expect((next.body as { items: unknown[] }).items).toHaveLength(2);
    const incoming = await request(app.getHttpServer())
      .get('/v1/activity')
      .set('privy-id-token', 'other')
      .expect(200);
    expect((incoming.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        id: intent.id,
        direction: 'INCOMING',
        state: 'CONFIRMED',
        txHash: transferHash.toLowerCase(),
      }),
    ]);
    await request(app.getHttpServer())
      .get('/v1/activity')
      .query({ cursor: uncertainId })
      .set('privy-id-token', 'other')
      .expect(400);

    await db.paymentIntent.update({
      where: { id: (fourth.body as { id: string }).id },
      data: { authorizationExpiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await request(app.getHttpServer())
      .get('/v1/activity')
      .set('privy-id-token', 'payer')
      .expect(200);
    expect(
      (expired.body as { items: { id: string; state: string }[] }).items.find(
        (item) => item.id === (fourth.body as { id: string }).id,
      )?.state,
    ).toBe('EXPIRED');
  });
});
