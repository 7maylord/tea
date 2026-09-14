import { randomBytes } from 'node:crypto';
import {
  decryptIdentity,
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
    expect(decryptIdentity(stored, encryptionSecret)).toBe(email);
    expect(readIdentityKey(lookupSecret.toString('base64'))).toEqual(
      lookupSecret,
    );
  });
});
