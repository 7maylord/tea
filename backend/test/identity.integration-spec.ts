import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { User } from '@privy-io/node';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { identityKey, normalizeEmail } from '../src/identity/identity.crypto';
import { SessionService } from '../src/identity/session.service';

const firstDid = `did:privy:${randomUUID()}`;
const secondDid = `did:privy:${randomUUID()}`;
const thirdDid = `did:privy:${randomUUID()}`;
const address = `0x${randomBytes(20).toString('hex')}`;
const otherAddress = `0x${randomBytes(20).toString('hex')}`;
const thirdAddress = `0x${randomBytes(20).toString('hex')}`;
const firstEmail = `${randomUUID()}@example.com`;
const secondEmail = `${randomUUID()}@example.com`;
const thirdEmail = `${randomUUID()}@example.com`;

function providerUser(
  did: string,
  email: string,
  wallet: string,
  verifiedAt = 1_700_000_000,
): User {
  return {
    id: did,
    is_guest: false,
    linked_accounts: [
      { type: 'email', address: email, verified_at: verifiedAt },
      {
        type: 'wallet',
        wallet_client_type: 'privy',
        connector_type: 'embedded',
        chain_type: 'ethereum',
        address: wallet,
        verified_at: verifiedAt,
      },
    ],
  } as User;
}

describe('session identity sync (Postgres)', () => {
  let app: INestApplication<App>;
  const db = new PrismaClient();
  const lookupSecret = randomBytes(32);
  let verified: jest.Mock<Promise<User>, [string]>;

  beforeAll(async () => {
    process.env.CHAIN_ID = '31337';
    process.env.IDENTITY_LOOKUP_HMAC_KEY = lookupSecret.toString('base64');
    process.env.IDENTITY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    verified = jest.fn(() =>
      Promise.resolve(providerUser(firstDid, firstEmail, address)),
    );
    Object.defineProperty(app.get(SessionService), 'verifiedUser', {
      value: verified,
    });
    await app.init();
  });

  afterAll(async () => {
    const users = await db.user.findMany({
      where: { privyDid: { in: [firstDid, secondDid, thirdDid] } },
      select: { id: true },
    });
    const ids = users.map((user) => user.id);
    await db.identity.deleteMany({ where: { userId: { in: ids } } });
    await db.account.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
    await app.close();
  });

  it('syncs only provider-verified data and preserves one settlement account', async () => {
    await request(app.getHttpServer()).post('/v1/session/sync').expect(401);

    const first = await request(app.getHttpServer())
      .post('/v1/session/sync')
      .set('privy-id-token', 'verified-test-token')
      .send({ email: 'attacker@example.com', address: otherAddress })
      .expect(201);
    const repeat = await request(app.getHttpServer())
      .post('/v1/session/sync')
      .set('privy-id-token', 'verified-test-token')
      .expect(201);
    const firstBody = first.body as {
      id: string;
      account: { address: string };
    };
    expect(repeat.body).toEqual(firstBody);
    expect(firstBody.account.address).toBe(address);
    expect(await db.account.count({ where: { userId: firstBody.id } })).toBe(1);
    expect(await db.identity.count({ where: { userId: firstBody.id } })).toBe(
      1,
    );

    const oldKey = identityKey(normalizeEmail(firstEmail), lookupSecret);
    const identity = await db.identity.findUniqueOrThrow({
      where: { kind_lookupKey: { kind: 'email', lookupKey: oldKey } },
    });
    expect(
      Buffer.from(identity.encryptedValue).includes(Buffer.from(firstEmail)),
    ).toBe(false);

    verified.mockResolvedValue(providerUser(firstDid, secondEmail, address));
    await request(app.getHttpServer())
      .post('/v1/session/sync')
      .set('privy-id-token', 'verified-test-token')
      .expect(201);
    expect(
      await db.identity.findUnique({
        where: { kind_lookupKey: { kind: 'email', lookupKey: oldKey } },
      }),
    ).toBeNull();

    verified.mockResolvedValue(
      providerUser(firstDid, secondEmail, otherAddress),
    );
    await request(app.getHttpServer())
      .post('/v1/session/sync')
      .set('privy-id-token', 'verified-test-token')
      .expect(409);
    expect(
      (await db.account.findFirstOrThrow({ where: { userId: firstBody.id } }))
        .settlementAddress,
    ).toBe(address);

    verified.mockResolvedValue(
      providerUser(secondDid, secondEmail, otherAddress),
    );
    await request(app.getHttpServer())
      .post('/v1/session/sync')
      .set('privy-id-token', 'verified-test-token')
      .expect(409);

    verified.mockResolvedValue(
      providerUser(secondDid, firstEmail, otherAddress, 0),
    );
    await request(app.getHttpServer())
      .post('/v1/session/sync')
      .set('privy-id-token', 'verified-test-token')
      .expect(422);

    const handle = `u_${randomBytes(6).toString('hex')}`;
    verified.mockResolvedValue(providerUser(firstDid, secondEmail, address));
    await request(app.getHttpServer()).post('/v1/me/handle').expect(401);
    await request(app.getHttpServer())
      .post('/v1/me/handle')
      .set('privy-id-token', 'verified-test-token')
      .send({ handle: 'admin' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/v1/me/handle')
      .set('privy-id-token', 'verified-test-token')
      .send({ handle })
      .expect(201, { handle });
    await request(app.getHttpServer())
      .post('/v1/me/handle')
      .set('privy-id-token', 'verified-test-token')
      .send({ handle })
      .expect(201, { handle });
    await request(app.getHttpServer())
      .post('/v1/me/handle')
      .set('privy-id-token', 'verified-test-token')
      .send({ handle: `x_${handle}` })
      .expect(409);

    verified.mockResolvedValue(
      providerUser(secondDid, firstEmail, otherAddress),
    );
    await request(app.getHttpServer())
      .post('/v1/me/handle')
      .set('privy-id-token', 'verified-test-token')
      .send({ handle })
      .expect(409);
  });

  it('allows only one winner for a concurrent handle claim', async () => {
    const handle = `u_${randomBytes(6).toString('hex')}`;
    verified.mockImplementation((token) =>
      Promise.resolve(
        token === 'third'
          ? providerUser(thirdDid, thirdEmail, thirdAddress)
          : providerUser(secondDid, firstEmail, otherAddress),
      ),
    );
    const responses = await Promise.all(
      ['second', 'third'].map((token) =>
        request(app.getHttpServer())
          .post('/v1/me/handle')
          .set('privy-id-token', token)
          .send({ handle }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(await db.user.count({ where: { handle } })).toBe(1);
  });
});
