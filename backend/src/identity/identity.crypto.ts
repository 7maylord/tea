import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';

export const NORMALIZATION_VERSION = 1;

export function normalizeEmail(value: string): string {
  const email = value.trim();
  const at = email.lastIndexOf('@');
  if (
    at < 1 ||
    at === email.length - 1 ||
    email.slice(0, at).includes('@') ||
    /\s/.test(email)
  ) {
    throw new Error('Invalid verified email');
  }
  const domain = domainToASCII(email.slice(at + 1)).toLowerCase();
  if (!domain) throw new Error('Invalid verified email');
  return `${email.slice(0, at)}@${domain}`;
}

export function identityKey(value: string, key: Buffer): string {
  return createHmac('sha256', key)
    .update('email:v1:')
    .update(value)
    .digest('hex');
}

export function encryptIdentity(value: string, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function readIdentityKey(value: string | undefined): Buffer {
  const key = Buffer.from(value ?? '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('Identity key must be a base64-encoded 32-byte value');
  }
  return key;
}
