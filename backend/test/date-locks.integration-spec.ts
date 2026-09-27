import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeFunctionData,
  http,
  type Address,
  type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import dateUnlockAbiJson from '../src/abi/TeaDateUnlock.json';
import tokenAbiJson from '../src/abi/TestUSD.json';
import { SessionService } from '../src/identity/session.service';

const senderAccount = privateKeyToAccount(
  `0x${randomBytes(32).toString('hex')}`,
);
const recipientAccount = privateKeyToAccount(
  `0x${randomBytes(32).toString('hex')}`,
);
const dateUnlockAbi = dateUnlockAbiJson as any;
const tokenAbi = tokenAbiJson as any;

describe('date unlock intents (Postgres and Anvil)', () => {
  const db = new PrismaClient();
  let app: INestApplication<App>;
  let senderId: string;
  let recipientId: string;

  beforeAll(async () => {
    process.env.CHAIN_ID = '31337';
    const sender = await db.user.create({
      data: {
        privyDid: `did:privy:${randomUUID()}`,
        handle: `u_${randomBytes(6).toString('hex')}`,
      },
    });
    const recipient = await db.user.create({
      data: { privyDid: `did:privy:${randomUUID()}` },
    });
    senderId = sender.id;
    recipientId = recipient.id;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SessionService)
      .useValue({
        sync: jest.fn((token: string) =>
          Promise.resolve({
            id: token === 'recipient' ? recipientId : senderId,
            handle: sender.handle,
            account: {
              chainId: 31337,
              address:
                token === 'recipient'
                  ? recipientAccount.address.toLowerCase()
                  : senderAccount.address.toLowerCase(),
            },
          }),
        ),
        recipientSnapshot: jest.fn(() =>
          Promise.resolve({
            userId: recipientId,
            destination: recipientAccount.address.toLowerCase(),
          }),
        ),
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
    const local = createWalletClient({
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const [faucet] = await local.getAddresses();
    const client = createPublicClient({ transport: http(process.env.RPC_URL) });
    const mint = await local.writeContract({
      account: faucet,
      address: process.env.SETTLEMENT_TOKEN as Address,
      abi: tokenAbi,
      functionName: 'mint',
      args: [senderAccount.address, 5_000_000n],
    });
    await client.waitForTransactionReceipt({ hash: mint });
    const senderGas = await local.sendTransaction({
      account: faucet,
      to: senderAccount.address,
      value: 10n ** 18n,
    });
    await client.waitForTransactionReceipt({ hash: senderGas });
    const recipientGas = await local.sendTransaction({
      account: faucet,
      to: recipientAccount.address,
      value: 10n ** 18n,
    });
    await client.waitForTransactionReceipt({ hash: recipientGas });
  });

  afterAll(async () => {
    await db.dateUnlockAction.deleteMany({
      where: { intent: { payerId: senderId } },
    });
    await db.transactionAttempt.deleteMany({
      where: { intent: { payerId: senderId } },
    });
    await db.paymentIntent.deleteMany({ where: { payerId: senderId } });
    await db.thread.deleteMany({
      where: { OR: [{ lowerUserId: senderId }, { upperUserId: senderId }] },
    });
    await db.user.deleteMany({
      where: { id: { in: [senderId, recipientId] } },
    });
    await db.$disconnect();
    await app.close();
  });

  it('creates a funded lock and allows only post-date recipient collection', async () => {
    const client = createPublicClient({ transport: http(process.env.RPC_URL) });
    const block = await client.getBlock();
    const unlockAtSeconds = Number(block.timestamp) + 600;
    const body = {
      recipientReference: randomBytes(32).toString('base64url'),
      amountUnits: '3000000',
      unlockAt: new Date(unlockAtSeconds * 1000).toISOString(),
    };
    await request(app.getHttpServer())
      .post('/v1/date-locks')
      .send(body)
      .expect(401);
    await request(app.getHttpServer())
      .post('/v1/date-locks')
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'invalid-date')
      .send({ ...body, unlockAt: new Date(Date.now() - 1000).toISOString() })
      .expect(400);

    const prepared = await request(app.getHttpServer())
      .post('/v1/date-locks')
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'date-one')
      .send(body)
      .expect(201);
    const dateLock = prepared.body as {
      id: string;
      plan: {
        approve: { to: Address; data: Hex };
        create: { to: Address; data: Hex };
      };
    };
    expect(dateLock.plan.create.to).toBe(
      process.env.TEA_DATE_UNLOCK_ADDRESS?.toLowerCase(),
    );
    const decoded = decodeFunctionData({
      abi: dateUnlockAbi,
      data: dateLock.plan.create.data,
    });
    expect(decoded.functionName).toBe('create');
    expect(decoded.args).toEqual([
      recipientAccount.address,
      3_000_000n,
      BigInt(unlockAtSeconds),
    ]);

    const replay = await request(app.getHttpServer())
      .post('/v1/date-locks')
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'date-one')
      .send(body)
      .expect(201);
    expect((replay.body as { id: string }).id).toBe(dateLock.id);
    await request(app.getHttpServer())
      .post('/v1/date-locks')
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'date-one')
      .send({ ...body, amountUnits: '2000000' })
      .expect(409);

    const signer = createWalletClient({
      account: senderAccount,
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const approvalHash = await signer.sendTransaction({
      to: dateLock.plan.approve.to,
      data: dateLock.plan.approve.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: approvalHash });
    await request(app.getHttpServer())
      .post(`/v1/date-locks/${dateLock.id}/submission`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'submit-date')
      .send({ txHash: approvalHash })
      .expect(409);

    const createHash = await signer.sendTransaction({
      to: dateLock.plan.create.to,
      data: dateLock.plan.create.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: createHash });
    const submitted = await request(app.getHttpServer())
      .post(`/v1/date-locks/${dateLock.id}/submission`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'submit-date')
      .send({ txHash: createHash })
      .expect(201);
    const confirmed = submitted.body as {
      state: string;
      dateLockId: string;
      txHash: string;
    };
    expect(confirmed.state).toBe('CONFIRMED');
    expect(confirmed.txHash).toBe(createHash.toLowerCase());

    await request(app.getHttpServer())
      .get(`/v1/date-locks/${dateLock.id}`)
      .set('privy-id-token', 'recipient')
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/date-locks/${dateLock.id}/withdraw`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'wrong-withdrawer')
      .expect(403);
    await request(app.getHttpServer())
      .post(`/v1/date-locks/${dateLock.id}/withdraw`)
      .set('privy-id-token', 'recipient')
      .set('Idempotency-Key', 'early-withdraw')
      .expect(409);

    const testClient = createTestClient({
      chain: foundry,
      mode: 'anvil',
      transport: http(process.env.RPC_URL),
    });
    await testClient.increaseTime({ seconds: 601 });
    await testClient.mine({ blocks: 1 });

    const collect = await request(app.getHttpServer())
      .post(`/v1/date-locks/${dateLock.id}/withdraw`)
      .set('privy-id-token', 'recipient')
      .set('Idempotency-Key', 'collect-date')
      .expect(201);
    const action = collect.body as {
      id: string;
      withdrawableUnits: string;
      plan: { to: Address; data: Hex };
    };
    expect(action.withdrawableUnits).toBe('3000000');
    const collectReplay = await request(app.getHttpServer())
      .post(`/v1/date-locks/${dateLock.id}/withdraw`)
      .set('privy-id-token', 'recipient')
      .set('Idempotency-Key', 'collect-date')
      .expect(201);
    expect((collectReplay.body as { id: string }).id).toBe(action.id);

    const recipientSigner = createWalletClient({
      account: recipientAccount,
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const withdrawHash = await recipientSigner.sendTransaction({
      to: action.plan.to,
      data: action.plan.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: withdrawHash });
    await request(app.getHttpServer())
      .post(`/v1/date-locks/${dateLock.id}/actions/${action.id}/submission`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'collect-submit')
      .send({ txHash: withdrawHash })
      .expect(404);
    const collected = await request(app.getHttpServer())
      .post(`/v1/date-locks/${dateLock.id}/actions/${action.id}/submission`)
      .set('privy-id-token', 'recipient')
      .set('Idempotency-Key', 'collect-submit')
      .send({ txHash: withdrawHash })
      .expect(201);
    expect(
      collected.body as { state: string; amountUnits: string },
    ).toMatchObject({
      state: 'CONFIRMED',
      amountUnits: '3000000',
    });
    await request(app.getHttpServer())
      .post(`/v1/date-locks/${dateLock.id}/withdraw`)
      .set('privy-id-token', 'recipient')
      .set('Idempotency-Key', 'collect-again')
      .expect(409);
    expect(
      await client.readContract({
        address: process.env.SETTLEMENT_TOKEN as Address,
        abi: tokenAbi,
        functionName: 'balanceOf',
        args: [recipientAccount.address],
      }),
    ).toBe(3_000_000n);
  });
});
