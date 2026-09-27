import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData } from 'viem';
import streamAbi from '../abi/TeaStream.json' with { type: 'json' };
import tokenAbi from '../abi/TestUSD.json' with { type: 'json' };
import { checkedStoredStreamAction, checkedStreamAction, checkedStreamPlan } from '../app/stream-plan.ts';
test('validates funded stream creation and actions', () => {
  const sender='0x0000000000000000000000000000000000000001', recipient='0x0000000000000000000000000000000000000002', token='0x0000000000000000000000000000000000000003', contract='0x0000000000000000000000000000000000000004';
  const intent={id:'id',state:'AWAITING_AUTHORIZATION',chainId:10143,token,streamContract:contract,sender,recipient,amountUnits:'1000000',durationSeconds:'300',streamId:null,plan:{approve:{chainId:10143,from:sender,to:token,value:'0',data:encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[contract,1000000n]})},create:{chainId:10143,from:sender,to:contract,value:'0',data:encodeFunctionData({abi:streamAbi,functionName:'create',args:[recipient,1000000n,300]})}}};
  assert.equal(checkedStreamPlan(intent,sender,token,10143,recipient,'1000000','300'),intent.plan);
  assert.throws(()=>checkedStreamPlan(intent,sender,token,10143,recipient,'1000000','301'));
  const action={id:'11111111-1111-4111-8111-111111111111',kind:'withdraw',state:'READY',plan:{chainId:10143,from:recipient,to:contract,value:'0',data:encodeFunctionData({abi:streamAbi,functionName:'withdraw',args:[7n]})}};
  assert.equal(checkedStreamAction(action,'withdraw',recipient,contract,10143,'7'),action.plan);
  assert.throws(()=>checkedStreamAction(action,'cancel',recipient,contract,10143,'7'));
  assert.throws(()=>checkedStreamAction(action,'withdraw',recipient,contract,10143,'8'));
});
test('accepts only complete stream action recovery records', () => {
  const id='11111111-1111-4111-8111-111111111111', key='22222222-2222-4222-8222-222222222222';
  const preparing={intentId:id,actionId:null,prepareKey:key,submitKey:key,kind:'withdraw',stage:'PREPARING'};
  const submitted={...preparing,actionId:'33333333-3333-4333-8333-333333333333',stage:'SUBMITTED',hash:`0x${'1'.repeat(64)}`};
  assert.deepEqual(checkedStoredStreamAction(preparing,id),preparing);
  assert.deepEqual(checkedStoredStreamAction(submitted,id),submitted);
  assert.equal(checkedStoredStreamAction({...submitted,hash:undefined},id),null);
  assert.equal(checkedStoredStreamAction({...preparing,intentId:'wrong'},id),null);
});
