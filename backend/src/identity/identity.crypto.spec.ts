import { createDecipheriv, randomBytes } from 'node:crypto';
import {
  encryptIdentity,
  identityKey,
  normalizeEmail,
  readIdentityKey,
} from './identity.crypto';

describe('identity storage', () => {
  it('preserves the local part, normalizes the domain, and encrypts the lookup value', () => {
    const email = normalizeEmail('  Name+tag@EXAMPLE.COM  ');
    expect(email).toBe('Name+tag@example.com');
    expect(normalizeEmail('name+tag@example.com')).not.toBe(email);

    const lookupSecret = randomBytes(32);
    const encryptionSecret = randomBytes(32);
    expect(identityKey(email, lookupSecret)).toHaveLength(64);
    expect(identityKey(email, lookupSecret)).not.toBe(
      identityKey('name+tag@example.com', lookupSecret),
    );

    const stored = encryptIdentity(email, encryptionSecret);
    expect(stored.includes(Buffer.from(email))).toBe(false);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionSecret,
      stored.subarray(0, 12),
    );
    decipher.setAuthTag(stored.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(stored.subarray(28)),
      decipher.final(),
    ]);
    expect(plaintext.toString()).toBe(email);
    expect(readIdentityKey(lookupSecret.toString('base64'))).toEqual(
      lookupSecret,
    );
  });
});
