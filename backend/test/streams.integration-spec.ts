import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  http,
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

const senderAccount = privateKeyToAccount(
  `0x${randomBytes(32).toString('hex')}`,
);
const recipientAccount = privateKeyToAccount(
  `0x${randomBytes(32).toString('hex')}`,
);
const createAbi = parseAbi([
  'function create(address recipient, uint256 amount, uint64 duration) returns (uint256 streamId)',
  'function streams(uint256 streamId) view returns (address sender, address recipient, uint256 deposit, uint256 withdrawn, uint256 entitlement, uint64 start, uint64 end, bool canceled)',
]);

describe('stream creation (Postgres and Anvil)', () => {
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
      abi: parseAbi(['function mint(address recipient, uint256 amount)']),
      functionName: 'mint',
      args: [senderAccount.address, 10_000_000n],
    });
    await client.waitForTransactionReceipt({ hash: mint });
    const gas = await local.sendTransaction({
      account: faucet,
      to: senderAccount.address,
      value: 10n ** 18n,
    });
    await client.waitForTransactionReceipt({ hash: gas });
    const recipientGas = await local.sendTransaction({
      account: faucet,
      to: recipientAccount.address,
      value: 10n ** 18n,
    });
    await client.waitForTransactionReceipt({ hash: recipientGas });
  });

  afterAll(async () => {
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

  it('reserves the full amount and confirms only the exact funded creation', async () => {
    const body = {
      recipientReference: randomBytes(32).toString('base64url'),
      amountUnits: '6000000',
      durationSeconds: '600',
    };
    await request(app.getHttpServer())
      .post('/v1/streams')
      .send(body)
      .expect(401);
    await request(app.getHttpServer())
      .post('/v1/streams')
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'invalid-duration')
      .send({ ...body, durationSeconds: '9223372036854775808' })
      .expect(400);
    const prepared = await request(app.getHttpServer())
      .post('/v1/streams')
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'stream-one')
      .send(body)
      .expect(201);
    const stream = prepared.body as {
      id: string;
      plan: {
        approve: { to: Address; data: Hex };
        create: { to: Address; data: Hex };
      };
    };
    expect(stream.plan.create.to).toBe(
      process.env.TEA_STREAM_ADDRESS?.toLowerCase(),
    );
    const decoded = decodeFunctionData({
      abi: createAbi,
      data: stream.plan.create.data,
    });
    expect(decoded.functionName).toBe('create');
    expect(decoded.args).toEqual([recipientAccount.address, 6_000_000n, 600n]);
    const replay = await request(app.getHttpServer())
      .post('/v1/streams')
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'stream-one')
      .send(body)
      .expect(201);
    expect((replay.body as { id: string }).id).toBe(stream.id);
    await request(app.getHttpServer())
      .post('/v1/streams')
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'stream-one')
      .send({ ...body, amountUnits: '5000000' })
      .expect(409);
    await request(app.getHttpServer())
      .post('/v1/payments')
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'send-after-stream')
      .send({
        recipientReference: body.recipientReference,
        amountUnits: '5000000',
      })
      .expect(422);
    await request(app.getHttpServer())
      .get(`/v1/payments/${stream.id}`)
      .set('privy-id-token', 'sender')
      .expect(404);
    await request(app.getHttpServer())
      .get(`/v1/streams/${stream.id}`)
      .set('privy-id-token', 'recipient')
      .expect(404);

    const signer = createWalletClient({
      account: senderAccount,
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const client = createPublicClient({ transport: http(process.env.RPC_URL) });
    const approvalHash = await signer.sendTransaction({
      to: stream.plan.approve.to,
      data: stream.plan.approve.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: approvalHash });
    await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/submission`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'submit-stream')
      .send({ txHash: approvalHash })
      .expect(409);
    const createHash = await signer.sendTransaction({
      to: stream.plan.create.to,
      data: stream.plan.create.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: createHash });
    const submitted = await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/submission`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'submit-stream')
      .send({ txHash: createHash })
      .expect(201);
    const confirmed = submitted.body as {
      state: string;
      streamId: string;
      txHash: string;
    };
    expect(confirmed.state).toBe('CONFIRMED');
    expect(confirmed.txHash).toBe(createHash.toLowerCase());
    const onchain = await client.readContract({
      address: process.env.TEA_STREAM_ADDRESS as Address,
      abi: createAbi,
      functionName: 'streams',
      args: [BigInt(confirmed.streamId)],
    });
    expect(onchain[0].toLowerCase()).toBe(senderAccount.address.toLowerCase());
    expect(onchain[1].toLowerCase()).toBe(
      recipientAccount.address.toLowerCase(),
    );
    expect(onchain[2]).toBe(6_000_000n);
    await request(app.getHttpServer())
      .get(`/v1/streams/${stream.id}`)
      .set('privy-id-token', 'recipient')
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/withdraw`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'wrong-withdrawer')
      .expect(403);
    await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/cancel`)
      .set('privy-id-token', 'recipient')
      .set('Idempotency-Key', 'wrong-canceller')
      .expect(403);
    await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/submission`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'submit-stream')
      .send({ txHash: createHash })
      .expect(201);
    expect(
      await client.readContract({
        address: process.env.SETTLEMENT_TOKEN as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [senderAccount.address],
      }),
    ).toBe(4_000_000n);

    const testClient = createTestClient({
      chain: foundry,
      mode: 'anvil',
      transport: http(process.env.RPC_URL),
    });
    await testClient.increaseTime({ seconds: 300 });
    await testClient.mine({ blocks: 1 });
    const collect = await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/withdraw`)
      .set('privy-id-token', 'recipient')
      .set('Idempotency-Key', 'collect-once')
      .expect(201);
    const collectPlan = collect.body as {
      withdrawableUnits: string;
      plan: { to: Address; data: Hex };
    };
    expect(BigInt(collectPlan.withdrawableUnits)).toBeGreaterThan(0n);
    expect(BigInt(collectPlan.withdrawableUnits)).toBeLessThan(6_000_000n);
    const recipientSigner = createWalletClient({
      account: recipientAccount,
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const firstCollectHash = await recipientSigner.sendTransaction({
      to: collectPlan.plan.to,
      data: collectPlan.plan.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: firstCollectHash });
    const afterCollect = await request(app.getHttpServer())
      .get(`/v1/streams/${stream.id}`)
      .set('privy-id-token', 'recipient')
      .expect(200);
    const withdrawnBeforeCancel = BigInt(
      (
        afterCollect.body as {
          chainState: { withdrawnUnits: string };
        }
      ).chainState.withdrawnUnits,
    );
    expect(withdrawnBeforeCancel).toBeGreaterThan(0n);
    await testClient.increaseTime({ seconds: 60 });
    await testClient.mine({ blocks: 1 });
    const cancel = await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/cancel`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'cancel-once')
      .expect(201);
    const cancelPlan = (cancel.body as { plan: { to: Address; data: Hex } })
      .plan;
    const cancelHash = await signer.sendTransaction({
      to: cancelPlan.to,
      data: cancelPlan.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: cancelHash });
    await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/cancel`)
      .set('privy-id-token', 'sender')
      .set('Idempotency-Key', 'cancel-again')
      .expect(409);
    const afterCancel = await request(app.getHttpServer())
      .get(`/v1/streams/${stream.id}`)
      .set('privy-id-token', 'recipient')
      .expect(200);
    const frozen = (
      afterCancel.body as {
        chainState: {
          canceled: boolean;
          recipientEntitlementUnits: string;
          withdrawableUnits: string;
        };
      }
    ).chainState;
    expect(frozen.canceled).toBe(true);
    expect(BigInt(frozen.withdrawableUnits)).toBeGreaterThan(0n);
    const finalCollect = await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/withdraw`)
      .set('privy-id-token', 'recipient')
      .set('Idempotency-Key', 'collect-rest')
      .expect(201);
    const finalPlan = (
      finalCollect.body as { plan: { to: Address; data: Hex } }
    ).plan;
    const finalHash = await recipientSigner.sendTransaction({
      to: finalPlan.to,
      data: finalPlan.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: finalHash });
    const finalState = await request(app.getHttpServer())
      .get(`/v1/streams/${stream.id}`)
      .set('privy-id-token', 'recipient')
      .expect(200);
    expect(
      (
        finalState.body as {
          chainState: { withdrawnUnits: string; withdrawableUnits: string };
        }
      ).chainState,
    ).toMatchObject({
      withdrawnUnits: frozen.recipientEntitlementUnits,
      withdrawableUnits: '0',
    });
    await request(app.getHttpServer())
      .post(`/v1/streams/${stream.id}/withdraw`)
      .set('privy-id-token', 'recipient')
      .set('Idempotency-Key', 'collect-empty')
      .expect(409);
    const [senderBalance, recipientBalance] = await Promise.all([
      client.readContract({
        address: process.env.SETTLEMENT_TOKEN as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [senderAccount.address],
      }),
      client.readContract({
        address: process.env.SETTLEMENT_TOKEN as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [recipientAccount.address],
      }),
    ]);
    expect(recipientBalance).toBe(BigInt(frozen.recipientEntitlementUnits));
    expect(senderBalance + recipientBalance).toBe(10_000_000n);
  });
});
