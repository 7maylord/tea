import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveMeraVaultKey } from '../app/mera-vault-crypto.ts';
import { copyMeraWallet, meraKey } from '../app/mera-storage.ts';

test('derives a non-exportable vault key that encrypts private notes', async () => {
  const key = await deriveMeraVaultKey(new Uint8Array(32).fill(7));
  const iv = new Uint8Array(12).fill(3);
  const plaintext = new TextEncoder().encode('private payment note');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

  assert.equal(key.extractable, false);
  assert.equal(new TextDecoder().decode(decrypted), 'private payment note');
});

test('does not replace a TEA user wallet with a stale login wallet', () => {
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const loginWallet = { credential: { credentialId: 'login' }, address: `0x${'1'.repeat(40)}` };
  const userWallet = { credential: { credentialId: 'user' }, address: `0x${'2'.repeat(40)}` };
  values.set(meraKey('did'), JSON.stringify(loginWallet));
  values.set(meraKey('user'), JSON.stringify(userWallet));

  try {
    copyMeraWallet('did', 'user');
    assert.deepEqual(JSON.parse(values.get(meraKey('user'))), userWallet);
  } finally {
    if (previous) globalThis.localStorage = previous;
    else delete globalThis.localStorage;
  }
});
