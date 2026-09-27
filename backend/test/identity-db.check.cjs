const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const db = new PrismaClient();
const userIds = [];

async function check() {
  const handle = `u_${randomBytes(6).toString('hex')}`;
  const address = `0x${randomBytes(20).toString('hex')}`;
  const lookupKey = randomBytes(32).toString('hex');
  const first = await db.user.create({ data: { privyDid: randomUUID(), handle } });
  userIds.push(first.id);
  const second = await db.user.create({ data: { privyDid: randomUUID() } });
  userIds.push(second.id);

  await assert.rejects(
    db.user.update({ where: { id: second.id }, data: { handle } }),
    { code: 'P2002' },
  );
  await assert.rejects(
    db.user.update({ where: { id: second.id }, data: { handle: 'admin' } }),
  );

  await db.identity.create({
    data: {
      userId: first.id,
      encryptedValue: randomBytes(48),
      lookupKey,
      verifiedAt: new Date(),
    },
  });
  await assert.rejects(
    db.identity.create({
      data: {
        userId: second.id,
        encryptedValue: randomBytes(48),
        lookupKey,
        verifiedAt: new Date(),
      },
    }),
    { code: 'P2002' },
  );

  await db.account.create({
    data: { userId: first.id, chainId: 10143, settlementAddress: address },
  });
  await assert.rejects(
    db.account.create({
      data: { userId: second.id, chainId: 10143, settlementAddress: address },
    }),
    { code: 'P2002' },
  );
  await assert.rejects(
    db.account.create({
      data: {
        userId: second.id,
        chainId: 10143,
        settlementAddress: address.toUpperCase(),
      },
    }),
  );

  console.log('Identity database constraints passed.');
}

check()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.identity.deleteMany({ where: { userId: { in: userIds } } });
    await db.account.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });
