import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

test('service worker handles only the public shell and static assets', () => {
  const listeners = {};
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    URL,
    caches: { match: async () => ({}), open: async () => ({ match: async () => ({}), put: async () => {} }) },
    fetch: async () => ({ ok: true, clone() { return this; } }),
    self: {
      location: { origin: 'https://tea.test' },
      addEventListener(name, handler) { listeners[name] = handler; },
    },
  });
  const handled = (url, method = 'GET', mode = 'navigate') => {
    let response;
    listeners.fetch({ request: { method, mode, url }, respondWith(value) { response = value; } });
    return response !== undefined;
  };
  assert.equal(handled('https://tea.test/'), true);
  assert.equal(handled('https://tea.test/_next/static/chunk.js', 'GET', 'no-cors'), true);
  assert.equal(handled('https://tea.test/manifest.webmanifest'), true);
  assert.equal(handled('https://tea.test/claim/private-token'), false);
  assert.equal(handled('https://api.tea.test/v1/activity'), false);
  assert.equal(handled('https://tea.test/', 'POST'), false);
});
