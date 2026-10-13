import type { PrismaClient } from '@prisma/client';
import {
  formatTeaAmount,
  sendTeaEmail,
  verifiedEmailForUser,
} from './tea-email';

let nextRetryAt = 0;

function appUrl() {
  const origin = process.env.APP_ORIGIN;
  if (!origin) throw new Error('App origin unavailable');
  return new URL('/app', origin).toString();
}

function duration(seconds: bigint) {
  if (seconds % 86_400n === 0n) return `${seconds / 86_400n} days`;
  if (seconds % 3_600n === 0n) return `${seconds / 3_600n} hours`;
  return `${seconds / 60n} minutes`;
}

export async function notifyPaymentRecipient(
  db: PrismaClient,
  intentId: string,
) {
  const intent = await db.paymentIntent.findUnique({
    where: { id: intentId },
    include: { payer: { select: { handle: true } } },
  });
  if (
    !intent ||
    intent.state !== 'CONFIRMED' ||
    intent.recipientNotifiedAt ||
    !intent.recipientUserId ||
    (intent.kind !== 'STREAM' && intent.kind !== 'DATE_LOCK')
  )
    return false;
  const sender = intent.payer.handle ? `@${intent.payer.handle}` : 'A friend';
  const amount = formatTeaAmount(
    BigInt(intent.amountUnits.toString()),
    intent.tokenAddress,
  );
  const stream = intent.kind === 'STREAM';
  const detail = stream
    ? `The ${duration(intent.durationSeconds!)} stream is funded and ready to accrue.`
    : `The funds unlock on ${intent.unlockAt!.toUTCString()}.`;
  await sendTeaEmail({
    to: await verifiedEmailForUser(db, intent.recipientUserId),
    subject: stream
      ? `${sender} started a payment stream for you on TEA`
      : `${sender} created an unlock-later payment for you on TEA`,
    preheader: `${amount} from ${sender}.`,
    eyebrow: stream ? 'A payment stream' : 'An unlock-later payment',
    heading: stream ? 'Something good is flowing.' : 'Something good is ahead.',
    body: stream
      ? `${sender} started a funded payment stream for you.`
      : `${sender} set aside a date-locked payment for you.`,
    amount,
    detail,
    ctaLabel: 'Open TEA',
    ctaUrl: appUrl(),
    idempotencyKey: `payment-notice:${intent.id}`,
  });
  await db.paymentIntent.updateMany({
    where: { id: intent.id, recipientNotifiedAt: null },
    data: { recipientNotifiedAt: new Date() },
  });
  return true;
}

export async function notifySplitParticipant(
  db: PrismaClient,
  obligationId: string,
) {
  const obligation = await db.splitObligation.findUnique({
    where: { id: obligationId },
    include: {
      split: { include: { organizer: { select: { handle: true } } } },
    },
  });
  if (!obligation || obligation.notifiedAt) return false;
  const organizer = obligation.split.organizer.handle
    ? `@${obligation.split.organizer.handle}`
    : 'A TEA member';
  const amount = formatTeaAmount(
    BigInt(obligation.amountUnits.toString()),
    obligation.split.tokenAddress,
  );
  const title = obligation.split.title ? ` for ${obligation.split.title}` : '';
  await sendTeaEmail({
    to: await verifiedEmailForUser(db, obligation.participantUserId),
    subject: `${organizer} sent you a split request on TEA`,
    preheader: `${amount} requested${title}.`,
    eyebrow: 'A split request',
    heading: 'Your part of the plan.',
    body: `${organizer} added you to a split${title}.`,
    amount,
    detail: `Open TEA to review and pay before ${obligation.split.expiresAt.toUTCString()}.`,
    ctaLabel: 'Review split',
    ctaUrl: appUrl(),
    idempotencyKey: `split-notice:${obligation.id}`,
  });
  await db.splitObligation.updateMany({
    where: { id: obligation.id, notifiedAt: null },
    data: { notifiedAt: new Date() },
  });
  return true;
}

export async function processPendingNotifications(db: PrismaClient) {
  if (Date.now() < nextRetryAt) return false;
  nextRetryAt = Date.now() + 30_000;
  const [payments, obligations] = await Promise.all([
    db.paymentIntent.findMany({
      where: {
        state: 'CONFIRMED',
        kind: { in: ['STREAM', 'DATE_LOCK'] },
        recipientNotifiedAt: null,
      },
      select: { id: true },
      take: 10,
    }),
    db.splitObligation.findMany({
      where: { notifiedAt: null },
      select: { id: true },
      take: 10,
    }),
  ]);
  if (!payments.length && !obligations.length) return false;
  await Promise.allSettled([
    ...payments.map(({ id }) => notifyPaymentRecipient(db, id)),
    ...obligations.map(({ id }) => notifySplitParticipant(db, id)),
  ]);
  return true;
}
