import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData } from 'viem';
import dateUnlockAbi from '../abi/TeaDateUnlock.json' with { type: 'json' };
import tokenAbi from '../abi/TestUSD.json' with { type: 'json' };
import { checkedDateLockAction, checkedDateLockPlan, checkedStoredDateLockAction } from '../app/date-lock-plan.ts';

test('validates date-lock creation and withdraw actions', () => {
  const sender='0x0000000000000000000000000000000000000001', recipient='0x0000000000000000000000000000000000000002', token='0x0000000000000000000000000000000000000003', contract='0x0000000000000000000000000000000000000004';
  const unlockAt='2026-10-10T12:00:00.000Z';
  const unlockSeconds=1791633600n;
  const intent={id:'id',state:'AWAITING_AUTHORIZATION',chainId:10143,token,dateUnlockContract:contract,sender,recipient,amountUnits:'1000000',unlockAt,dateLockId:null,plan:{approve:{chainId:10143,from:sender,to:token,value:'0',data:encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[contract,1000000n]})},create:{chainId:10143,from:sender,to:contract,value:'0',data:encodeFunctionData({abi:dateUnlockAbi,functionName:'create',args:[recipient,1000000n,unlockSeconds]})}}};
  assert.equal(checkedDateLockPlan(intent,sender,token,10143,recipient,'1000000',unlockAt),intent.plan);
  assert.throws(()=>checkedDateLockPlan(intent,sender,token,10143,recipient,'1000000','2026-10-10T12:00:01.000Z'));
  assert.throws(()=>checkedDateLockPlan(intent,sender,token,10143,sender,'1000000',unlockAt));
  const action={id:'11111111-1111-4111-8111-111111111111',kind:'withdraw',state:'READY',txHash:null,amountUnits:null,blockNumber:null,plan:{chainId:10143,from:recipient,to:contract,value:'0',data:encodeFunctionData({abi:dateUnlockAbi,functionName:'withdraw',args:[7n]})}};
  assert.equal(checkedDateLockAction(action,recipient,contract,10143,'7'),action.plan);
  assert.throws(()=>checkedDateLockAction(action,recipient,contract,10143,'8'));
});

test('accepts only complete date-lock action recovery records', () => {
  const id='11111111-1111-4111-8111-111111111111', key='22222222-2222-4222-8222-222222222222';
  const preparing={intentId:id,actionId:null,prepareKey:key,submitKey:key,stage:'PREPARING'};
  const submitted={...preparing,actionId:'33333333-3333-4333-8333-333333333333',stage:'SUBMITTED',hash:`0x${'1'.repeat(64)}`};
  assert.deepEqual(checkedStoredDateLockAction(preparing,id),preparing);
  assert.deepEqual(checkedStoredDateLockAction(submitted,id),submitted);
  assert.equal(checkedStoredDateLockAction({...submitted,hash:undefined},id),null);
  assert.equal(checkedStoredDateLockAction({...preparing,intentId:'wrong'},id),null);
});
