import { PrismaClient } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { decryptIdentity, readIdentityKey } from '../identity/identity.crypto';

const escrowAbi = parseAbi([
  'function claims(bytes32 claimId) view returns (address payer, uint256 amount, uint64 expiry, bytes32 identityCommitment, uint8 status)',
]);

export async function processNextClaimInvite(
  db: PrismaClient,
): Promise<boolean> {
  const now = new Date();
  const job = await db.outboxJob.findFirst({
    where: {
      kind: 'CLAIM_INVITE',
      OR: [
        { state: 'PENDING', nextAttemptAt: { lte: now } },
        { state: 'PROCESSING', leaseUntil: { lt: now } },
      ],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
  });
  if (!job) return false;
  const leaseUntil = new Date(Date.now() + 60_000);
  const locked = await db.outboxJob.updateMany({
    where: {
      id: job.id,
      state: job.state,
      ...(job.state === 'PROCESSING'
        ? { leaseUntil: job.leaseUntil }
        : { nextAttemptAt: job.nextAttemptAt }),
    },
    data: { state: 'PROCESSING', leaseUntil, attempts: { increment: 1 } },
  });
  if (locked.count !== 1) return true;

  try {
    const claim = await db.claim.findUniqueOrThrow({
      where: { id: job.claimId },
    });
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) throw new Error('RPC unavailable');
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000 }),
    });
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
      onchain[2] * 1000n !== BigInt(claim.expiry?.getTime() ?? 0)
    ) {
      throw new Error('Claim is not ready');
    }
    if (
      onchain[4] === 2 ||
      onchain[4] === 3 ||
      (onchain[4] === 1 && block.timestamp >= onchain[2])
    ) {
      await db.outboxJob.updateMany({
        where: { id: job.id, state: 'PROCESSING', leaseUntil },
        data: { state: 'CANCELED', leaseUntil: null },
      });
      return true;
    }
    if (claim.state !== 'OPEN' || onchain[4] !== 1)
      throw new Error('Claim is not ready');
    const emailKey = process.env.EMAIL_PROVIDER_KEY;
    const from = process.env.EMAIL_FROM;
    const appOrigin = process.env.APP_ORIGIN;
    if (!emailKey || !from || !appOrigin) throw new Error('Email unavailable');
    const encryptionKey = readIdentityKey(process.env.IDENTITY_ENCRYPTION_KEY);
    const email = decryptIdentity(claim.encryptedRecipientEmail, encryptionKey);
    const inviteToken = decryptIdentity(
      claim.encryptedInviteToken,
      encryptionKey,
    );
    const link = new URL(
      `/claim/${encodeURIComponent(inviteToken)}`,
      appOrigin,
    ).toString();
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${emailKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': job.dedupeKey,
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'You have a TEA payment',
        text: `Open your TEA invitation: ${link}\nSign in with this email to view and claim it.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Email provider unavailable');
    await db.outboxJob.updateMany({
      where: { id: job.id, state: 'PROCESSING', leaseUntil },
      data: { state: 'SENT', leaseUntil: null },
    });
  } catch {
    const backoffSeconds = Math.min(30 * 2 ** Math.min(job.attempts, 7), 3600);
    await db.outboxJob.updateMany({
      where: { id: job.id, state: 'PROCESSING', leaseUntil },
      data: {
        state: 'PENDING',
        leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
      },
    });
    console.error('Claim invite retry scheduled', job.id);
  }
  return true;
}

async function main() {
  const db = new PrismaClient();
  let stopping = false;
  process.once('SIGINT', () => {
    stopping = true;
  });
  process.once('SIGTERM', () => {
    stopping = true;
  });
  try {
    while (!stopping) {
      const processed = await processNextClaimInvite(db);
      if (!processed) await delay(2_000);
    }
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
