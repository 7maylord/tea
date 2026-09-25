import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData } from 'viem';
import escrowAbi from '../abi/TeaClaimEscrow.json' with { type: 'json' };
import tokenAbi from '../abi/TestUSD.json' with { type: 'json' };
import { checkedClaimPlan } from '../app/claim-plan.ts';

test('accepts only exact approval and escrow deposit plans', () => {
  const account = '0x0000000000000000000000000000000000000001';
  const escrow = '0x0000000000000000000000000000000000000002';
  const token = '0x0000000000000000000000000000000000000003';
  const id = `0x${'11'.repeat(32)}`;
  const commitment = `0x${'22'.repeat(32)}`;
  const intent = { id, state: 'AWAITING_DEPOSIT', chainId: 31337, escrow, token, payer: account, amountUnits: '1000000', plan: {
    approve: { chainId: 31337, from: account, to: token, value: '0', data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [escrow, 1000000n] }) },
    deposit: { chainId: 31337, from: account, to: escrow, value: '0', data: encodeFunctionData({ abi: escrowAbi, functionName: 'deposit', args: [id, commitment, 1000000n] }) },
  }};
  assert.equal(checkedClaimPlan(intent, account, token, 31337, '1000000'), intent.plan);
  assert.throws(() => checkedClaimPlan({ ...intent, plan: { ...intent.plan, deposit: { ...intent.plan.deposit,
    data: encodeFunctionData({ abi: escrowAbi, functionName: 'deposit', args: [id, commitment, 2n] }) } } }, account, token, 31337, '1000000'));
  assert.throws(() => checkedClaimPlan(intent, account, escrow, 31337, '1000000'));
});
