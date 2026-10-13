import type { PrismaClient } from '@prisma/client';
import { decryptIdentity, readIdentityKey } from '../identity/identity.crypto';

type Message = {
  to: string;
  subject: string;
  preheader: string;
  eyebrow: string;
  heading: string;
  body: string;
  amount?: string;
  detail?: string;
  ctaLabel: string;
  ctaUrl: string;
  idempotencyKey: string;
};

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

export function formatTeaAmount(units: bigint, tokenAddress?: string) {
  const decimals = Number(process.env.SETTLEMENT_TOKEN_DECIMALS ?? 6);
  const base = 10n ** BigInt(decimals);
  const fraction = (units % base)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  const ausd =
    process.env.AUSD_TOKEN ?? '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC';
  const primary = process.env.SETTLEMENT_TOKEN?.toLowerCase();
  const normalizedToken = tokenAddress?.toLowerCase();
  const symbol =
    normalizedToken === ausd.toLowerCase()
      ? 'AUSD'
      : normalizedToken === primary
        ? (process.env.SETTLEMENT_TOKEN_SYMBOL ?? 'TUSD')
        : 'tokens';
  return `${units / base}${fraction ? `.${fraction}` : ''} ${symbol}`;
}

export function renderTeaEmail(message: Message) {
  const safe = Object.fromEntries(
    Object.entries(message).map(([key, value]) => [
      key,
      typeof value === 'string' ? escapeHtml(value) : value,
    ]),
  ) as Record<keyof Message, string>;
  const summary = [message.body, message.amount, message.detail]
    .filter(Boolean)
    .join('\n\n');
  return {
    text: `${message.heading}\n\n${summary}\n\n${message.ctaLabel}: ${message.ctaUrl}\n\nTEA · Send money like a message.\nYou received this transactional email because this address is verified on TEA.`,
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>${safe.subject}</title></head><body style="margin:0;background:#f5f6ef;color:#173e32;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${safe.preheader}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6ef"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td style="padding:0 4px 24px;font-family:Georgia,serif;font-size:34px;font-weight:bold;letter-spacing:-1px">tea<span style="color:#e96b38">.</span></td></tr><tr><td style="overflow:hidden;border:1px solid #dce3d8;border-radius:28px;background:#ffffff"><div style="padding:36px 32px 14px;background:#173e32;color:#ffffff"><div style="margin-bottom:16px;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#d6ed9c">${safe.eyebrow}</div><h1 style="margin:0;font-family:Georgia,serif;font-size:38px;line-height:1.08;font-weight:normal">${safe.heading}</h1></div><div style="padding:30px 32px 36px"><p style="margin:0;color:#52645d;font-size:16px;line-height:1.65">${safe.body}</p>${message.amount ? `<div style="margin:26px 0 0;padding:22px;border-radius:18px;background:#eef2e6;font-family:Georgia,serif;font-size:32px;color:#173e32">${safe.amount}</div>` : ''}${message.detail ? `<p style="margin:18px 0 0;color:#52645d;font-size:14px;line-height:1.6">${safe.detail}</p>` : ''}<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px"><tr><td style="border-radius:14px;background:#d6ed9c"><a href="${safe.ctaUrl}" style="display:inline-block;padding:15px 22px;color:#173e32;font-size:15px;font-weight:bold;text-decoration:none">${safe.ctaLabel} &rarr;</a></td></tr></table><p style="margin:30px 0 0;border-top:1px solid #e7ebe3;padding-top:20px;color:#7b8983;font-size:12px;line-height:1.6">TEA · Send money like a message.<br>You received this transactional email because this address is verified on TEA.</p></div></td></tr></table></td></tr></table></body></html>`,
  };
}

export async function verifiedEmailForUser(db: PrismaClient, userId: string) {
  const identity = await db.identity.findFirst({
    where: { userId, kind: 'email' },
    select: { encryptedValue: true },
  });
  if (!identity) throw new Error('Recipient email unavailable');
  return decryptIdentity(
    identity.encryptedValue,
    readIdentityKey(process.env.IDENTITY_ENCRYPTION_KEY),
  );
}

export async function sendTeaEmail(message: Message) {
  const key = process.env.EMAIL_PROVIDER_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) throw new Error('Email unavailable');
  const content = renderTeaEmail(message);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': message.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: content.text,
      html: content.html,
      ...(process.env.EMAIL_REPLY_TO
        ? { reply_to: process.env.EMAIL_REPLY_TO }
        : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Email provider unavailable');
}
