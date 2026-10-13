import assert from 'node:assert/strict';
import { test } from 'node:test';
import { submitTransactionSequence } from '../app/transaction-sequence.ts';

test('waits for approval before submitting the funded transaction', async () => {
  const events = [];
  const hashes = await submitTransactionSequence(
    ['approve', 'fund'],
    async (transaction) => {
      events.push(`send:${transaction}`);
      return transaction === 'approve' ? `0x${'1'.repeat(64)}` : `0x${'2'.repeat(64)}`;
    },
    async () => { events.push('wait:approve'); },
    async (index) => { events.push(`saved:${index}`); },
  );

  assert.deepEqual(events, ['send:approve', 'saved:0', 'wait:approve', 'send:fund', 'saved:1']);
  assert.equal(hashes.length, 2);
});
