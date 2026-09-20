import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, erc20Abi, parseAbi } from 'viem';
import { checkedStreamAction, checkedStreamPlan } from '../app/stream-plan.ts';
const abi = parseAbi(['function create(address recipient,uint256 amount,uint64 duration) returns (uint256)', 'function withdraw(uint256 streamId) returns (uint256)']);
test('validates funded stream creation and actions', () => {
  const sender='0x0000000000000000000000000000000000000001', recipient='0x0000000000000000000000000000000000000002', token='0x0000000000000000000000000000000000000003', contract='0x0000000000000000000000000000000000000004';
  const intent={id:'id',state:'AWAITING_AUTHORIZATION',chainId:31337,token,streamContract:contract,sender,recipient,amountUnits:'1000000',durationSeconds:'300',streamId:null,plan:{approve:{chainId:31337,from:sender,to:token,value:'0',data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,1000000n]})},create:{chainId:31337,from:sender,to:contract,value:'0',data:encodeFunctionData({abi,functionName:'create',args:[recipient,1000000n,300]})}}};
  assert.equal(checkedStreamPlan(intent,sender,token,31337,recipient,'1000000','300'),intent.plan);
  assert.throws(()=>checkedStreamPlan(intent,sender,token,31337,recipient,'1000000','301'));
  const action={id:'id',kind:'withdraw',state:'READY',plan:{chainId:31337,from:recipient,to:contract,value:'0',data:encodeFunctionData({abi,functionName:'withdraw',args:[7n]})}};
  assert.equal(checkedStreamAction(action,recipient,contract,31337,'7'),action.plan);
  assert.throws(()=>checkedStreamAction(action,recipient,contract,31337,'8'));
});
