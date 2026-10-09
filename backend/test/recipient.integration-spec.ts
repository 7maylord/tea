import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { User } from '@privy-io/node';
import { createClient } from 'redis';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/identity/session.service';

const senderDid = `did:privy:${randomUUID()}`;
const targetDid = `did:privy:${randomUUID()}`;
const senderEmail = `${randomUUID()}@example.com`;
const targetEmail = `${randomUUID()}@example.com`;
const senderAddress = `0x${randomBytes(20).toString('hex')}`;
const targetAddress = `0x${randomBytes(20).toString('hex')}`;
const handle = `u_${randomBytes(6).toString('hex')}`;
const senderHandle = `u_${randomBytes(6).toString('hex')}`;

function providerUser(did: string, email: string, address: string): User {
  return {
    id: did,
    is_guest: false,
    linked_accounts: [
      { type: 'email', address: email, verified_at: 1_700_000_000 },
      {
        type: 'wallet',
        wallet_client_type: 'privy',
        connector_type: 'embedded',
        chain_type: 'ethereum',
        address,
        verified_at: 1_700_000_000,
      },
    ],
  } as User;
}

describe('recipient resolution (Postgres and Redis)', () => {
  let app: INestApplication<App>;
  const db = new PrismaClient();
  const redis = createClient({ url: process.env.REDIS_URL });
  let currentTarget = providerUser(targetDid, targetEmail, targetAddress);
  const references: string[] = [];

  beforeAll(async () => {
    process.env.CHAIN_ID = '10143';
    process.env.IDENTITY_LOOKUP_HMAC_KEY = randomBytes(32).toString('base64');
    process.env.IDENTITY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    const service = app.get(SessionService);
    Object.defineProperty(service, 'verifiedUser', {
      value: jest.fn((token: string) =>
        Promise.resolve(
          token === 'target'
            ? providerUser(targetDid, targetEmail, targetAddress)
            : providerUser(senderDid, senderEmail, senderAddress),
        ),
      ),
    });
    Object.defineProperty(service, 'currentProviderUser', {
      value: jest.fn(() => Promise.resolve(currentTarget)),
    });
    await app.init();
    await redis.connect();
    await request(app.getHttpServer())
      .post('/v1/session/sync')
      .set('privy-id-token', 'sender')
      .expect(201);
    const sender = await db.user.findUniqueOrThrow({
      where: { privyDid: senderDid },
    });
    await db.account.create({
      data: {
        userId: sender.id,
        chainId: 10143,
        settlementAddress: senderAddress.toLowerCase(),
      },
    });
    await request(app.getHttpServer())
      .post('/v1/resolve')
      .set('privy-id-token', 'sender')
      .send({ kind: 'handle', value: handle })
      .expect(409);
    await request(app.getHttpServer())
      .post('/v1/me/handle')
      .set('privy-id-token', 'sender')
      .send({ handle: senderHandle })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/session/sync')
      .set('privy-id-token', 'target')
      .expect(201);
    const target = await db.user.findUniqueOrThrow({
      where: { privyDid: targetDid },
    });
    await db.account.create({
      data: {
        userId: target.id,
        chainId: 10143,
        settlementAddress: targetAddress.toLowerCase(),
      },
    });
    await request(app.getHttpServer())
      .post('/v1/me/handle')
      .set('privy-id-token', 'target')
      .send({ handle })
      .expect(201);
  });

  afterAll(async () => {
    const users = await db.user.findMany({
      where: { privyDid: { in: [senderDid, targetDid] } },
      select: { id: true },
    });
    const ids = users.map((user) => user.id);
    await db.identity.deleteMany({ where: { userId: { in: ids } } });
    await db.account.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    for (const key of references) await redis.del(key);
    for (const id of ids) {
      await redis.del(`tea:resolve:${id}:${Math.floor(Date.now() / 60000)}`);
    }
    await redis.quit();
    await db.$disconnect();
    await app.close();
  });

  it('returns an expiring reference only for a current verified recipient', async () => {
    await request(app.getHttpServer())
      .post('/v1/resolve')
      .send({ kind: 'handle', value: handle })
      .expect(401);
    const found = await request(app.getHttpServer())
      .post('/v1/resolve')
      .set('privy-id-token', 'sender')
      .send({ kind: 'handle', value: handle })
      .expect(201);
    const body = found.body as {
      kind: string;
      reference: string;
      recipient: { handle: string };
    };
    expect(body.kind).toBe('existing');
    expect(body.recipient.handle).toBe(handle);
    expect(JSON.stringify(body)).not.toContain(targetAddress);
    expect(JSON.stringify(body)).not.toContain(targetEmail);
    const key = `tea:recipient:${createHash('sha256').update(body.reference).digest('hex')}`;
    references.push(key);
    const snapshot = JSON.parse((await redis.get(key)) ?? '{}') as {
      requesterId: string;
      destination: string;
      chainId: number;
    };
    expect(snapshot.requesterId).toBe(
      (await db.user.findUniqueOrThrow({ where: { privyDid: senderDid } })).id,
    );
    expect(snapshot).toMatchObject({
      destination: targetAddress,
      chainId: 10143,
    });
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    const service = app.get(SessionService);
    await expect(
      service.recipientSnapshot(body.reference, snapshot.requesterId, 10143),
    ).resolves.toMatchObject({ destination: targetAddress });
    await expect(
      service.recipientSnapshot(body.reference, snapshot.requesterId, 1),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      service.recipientSnapshot(body.reference, randomUUID(), 10143),
    ).rejects.toMatchObject({ status: 410 });

    const byEmail = await request(app.getHttpServer())
      .post('/v1/resolve')
      .set('privy-id-token', 'sender')
      .send({
        kind: 'email',
        value: targetEmail.replace('@example.com', '@EXAMPLE.COM'),
      })
      .expect(201);
    expect((byEmail.body as { kind: string }).kind).toBe('existing');
    references.push(
      `tea:recipient:${createHash('sha256')
        .update((byEmail.body as { reference: string }).reference)
        .digest('hex')}`,
    );

    currentTarget = providerUser(
      targetDid,
      `${randomUUID()}@example.com`,
      targetAddress,
    );
    await request(app.getHttpServer())
      .post('/v1/resolve')
      .set('privy-id-token', 'sender')
      .send({ kind: 'email', value: targetEmail })
      .expect(201, { kind: 'unregistered' });
    await request(app.getHttpServer())
      .post('/v1/resolve')
      .set('privy-id-token', 'sender')
      .send({ kind: 'handle', value: handle })
      .expect(404);

    currentTarget = providerUser(targetDid, targetEmail, senderAddress);
    const afterPrivyWalletChange = await request(app.getHttpServer())
      .post('/v1/resolve')
      .set('privy-id-token', 'sender')
      .send({ kind: 'handle', value: handle })
      .expect(201);
    expect(JSON.stringify(afterPrivyWalletChange.body)).not.toContain(
      senderAddress,
    );
    references.push(
      `tea:recipient:${createHash('sha256')
        .update(
          (afterPrivyWalletChange.body as { reference: string }).reference,
        )
        .digest('hex')}`,
    );
    currentTarget = providerUser(targetDid, targetEmail, targetAddress);

    const sender = await db.user.findUniqueOrThrow({
      where: { privyDid: senderDid },
    });
    await redis.set(
      `tea:resolve:${sender.id}:${Math.floor(Date.now() / 60000)}`,
      '20',
      { EX: 60 },
    );
    await request(app.getHttpServer())
      .post('/v1/resolve')
      .set('privy-id-token', 'sender')
      .send({ kind: 'handle', value: handle })
      .expect(429);
  });
});
