import { PrismaClient } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient as createPublicClientBase,
  http,
  type Address,
  type Hex,
} from 'viem';
import escrowAbiJson from '../abi/TeaClaimEscrow.json';
import { formatTeaAmount, sendTeaEmail } from '../email/tea-email';
import { processPendingNotifications } from '../email/notifications';
import { decryptIdentity, readIdentityKey } from '../identity/identity.crypto';
import { processNextClaimRefund } from './refund.worker';
import { processNextClaimRelay } from './relay.worker';

const escrowAbi = escrowAbiJson as any;
const createPublicClient = createPublicClientBase as any;

export async function processNextClaimInvite(
  db: PrismaClient,
  claimId?: string,
): Promise<boolean> {
  const now = new Date();
  const job = await db.outboxJob.findFirst({
    where: {
      kind: 'CLAIM_INVITE',
      ...(claimId ? { claimId } : {}),
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
      include: { payer: { select: { handle: true } } },
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
      onchain[1].toLowerCase() !== claim.tokenAddress ||
      onchain[2] !== BigInt(claim.amountUnits.toString()) ||
      onchain[4] !== claim.identityCommitment ||
      onchain[3] * 1000n !== BigInt(claim.expiry?.getTime() ?? 0)
    ) {
      throw new Error('Claim is not ready');
    }
    if (
      onchain[5] === 2 ||
      onchain[5] === 3 ||
      (onchain[5] === 1 && block.timestamp >= onchain[3])
    ) {
      await db.outboxJob.updateMany({
        where: { id: job.id, state: 'PROCESSING', leaseUntil },
        data: { state: 'CANCELED', leaseUntil: null },
      });
      return true;
    }
    if (claim.state !== 'OPEN' || onchain[5] !== 1)
      throw new Error('Claim is not ready');
    const appOrigin = process.env.APP_ORIGIN;
    if (!appOrigin) throw new Error('Email unavailable');
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
    const sender = claim.payer.handle ? `@${claim.payer.handle}` : 'A friend';
    await sendTeaEmail({
      to: email,
      subject: `${sender} sent you a payment on TEA`,
      preheader: `${formatTeaAmount(BigInt(claim.amountUnits.toString()), claim.tokenAddress)} is waiting for you.`,
      eyebrow: 'A TEA payment',
      heading: 'A little something arrived.',
      body: `${sender} sent you a payment. Verify this email and collect it securely with your TEA passkey.`,
      amount: formatTeaAmount(
        BigInt(claim.amountUnits.toString()),
        claim.tokenAddress,
      ),
      detail: `Claim it before ${claim.expiry?.toUTCString() ?? 'the invitation expires'}.`,
      ctaLabel: 'Collect payment',
      ctaUrl: link,
      idempotencyKey: job.dedupeKey,
    });
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

export async function runClaimWorker(signal?: AbortSignal) {
  const db = new PrismaClient();
  try {
    while (!signal?.aborted) {
      const [invite, refund, relay, notification] = await Promise.all([
        processNextClaimInvite(db),
        processNextClaimRefund(db),
        processNextClaimRelay(db),
        processPendingNotifications(db),
      ]);
      if (!invite && !refund && !relay && !notification) await delay(2_000);
    }
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  void runClaimWorker(controller.signal).catch(() => {
    process.exitCode = 1;
  });
}
