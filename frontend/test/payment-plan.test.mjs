import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import { checkedTransferPlan } from '../app/payment-plan.ts';

test('rejects a changed token, recipient or amount before signing', () => {
  const account = '0x0000000000000000000000000000000000000001';
  const recipient = '0x0000000000000000000000000000000000000002';
  const token = '0x0000000000000000000000000000000000000003';
  const intent = {
    id: 'test', state: 'AWAITING_AUTHORIZATION', chainId: 31337,
    token, payer: account, recipient, amountUnits: '1000000',
    authorizationExpiresAt: new Date(Date.now() + 60000).toISOString(),
    plan: { chainId: 31337, from: account, to: token, value: '0',
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, 1000000n] }) },
  };
  assert.equal(checkedTransferPlan(intent, account, token, 31337, '1000000'), intent.plan);
  assert.throws(() => checkedTransferPlan(intent, account, recipient, 31337, '1000000'));
  assert.throws(() => checkedTransferPlan({ ...intent, plan: { ...intent.plan,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [account, 1000000n] }) } }, account, token, 31337, '1000000'));
  assert.throws(() => checkedTransferPlan(intent, account, token, 31337, '2000000'));
  assert.throws(() => checkedTransferPlan({ ...intent, authorizationExpiresAt: 'invalid' }, account, token, 31337, '1000000'));
});
