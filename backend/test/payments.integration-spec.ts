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
  type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/identity/session.service';

const payerAddress = `0x${randomBytes(20).toString('hex')}`;
const recipientAddress = `0x${randomBytes(20).toString('hex')}`;
const reference = randomBytes(32).toString('base64url');

describe('direct payment intents (Postgres and Anvil)', () => {
  let app: INestApplication<App>;
  const db = new PrismaClient();
  let payerId: string;
  let recipientId: string;

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
      args: [payerAddress, 20_000_000n],
    });
    const client = createPublicClient({ transport: http(process.env.RPC_URL) });
    await client.waitForTransactionReceipt({ hash });
  });

  afterAll(async () => {
    await db.paymentIntent.deleteMany({ where: { payerId } });
    await db.user.deleteMany({ where: { id: { in: [payerId, recipientId] } } });
    await db.$disconnect();
    await app.close();
  });

  it('reserves once, replays the same intent and rejects overspending', async () => {
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
  });
});
