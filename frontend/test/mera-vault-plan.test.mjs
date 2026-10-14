import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveMeraVaultKey } from '../app/mera-vault-crypto.ts';

test('derives a non-exportable vault key that encrypts private notes', async () => {
  const key = await deriveMeraVaultKey(new Uint8Array(32).fill(7));
  const iv = new Uint8Array(12).fill(3);
  const plaintext = new TextEncoder().encode('private payment note');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

  assert.equal(key.extractable, false);
  assert.equal(new TextDecoder().decode(decrypted), 'private payment note');
});
