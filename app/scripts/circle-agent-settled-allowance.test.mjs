import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,stringToHex,decodeFunctionData,erc20Abi} from 'viem';
import {clearSettledCircleAllowance} from './circle-agent-settled-allowance.mjs';
import {parseSettledAgentArgs} from './shadow-circle-settled-testnet.mjs';
import {parseSettledMainnetArgs} from './shadow-circle-settled-mainnet.mjs';
const agent='0x'+'11'.repeat(20),contract='0x'+'22'.repeat(20),line='0x'+'33'.repeat(32),draw='0x'+'44'.repeat(32);
function setup(){
 const state={requests:{repay:{key:'original-repay'}},guardedRepayment:{version:1,line,draw,amount:'5000'}};
 const control={remaining:2000n,debt:0n,draw,failSave:false,lose:false,sends:0,reconciles:0,oldStatus:'confirmed',saved:null};
 const resetter={operationKey:r=>keccak256(stringToHex(JSON.stringify(r))),execute:async request=>{assert(control.saved.allowanceCleanup);const call=decodeFunctionData({abi:erc20Abi,data:request.data});assert.equal(call.functionName,'approve');assert.deepEqual(call.args,[contract,0n]);control.sends++;control.remaining=0n;return {status:control.lose?'unknown':'confirmed'}},reconcile:async()=>{control.reconciles++;return {status:control.lose?'unknown':'confirmed'}}};
 const options={agent,line,contract,state,save:async()=>{if(control.failSave)throw Error('disk failed');control.saved=structuredClone(state)},operations:{reconcile:async()=>({status:control.oldStatus})},readLine:async()=>({agent,drawDigest:control.draw,principalOutstanding:control.debt}),readAllowance:async()=>control.remaining,makeResetter:async()=>resetter};
 return {options,state,control};
}
test('cleanup persists separate zero approval review, then replay only reconciles',async()=>{const x=setup();assert.equal((await clearSettledCircleAllowance(x.options)).status,'confirmed');assert.equal(x.control.remaining,0n);assert.equal(x.state.requests.repay.key,'original-repay');await clearSettledCircleAllowance(x.options);assert.equal(x.control.sends,1);assert.equal(x.control.reconciles,1)});
test('unknown cleanup survives restart without another send',async()=>{const x=setup();x.control.lose=true;await assert.rejects(()=>clearSettledCircleAllowance(x.options),/unresolved/);const restored={...x.options,state:structuredClone(x.control.saved)};await assert.rejects(()=>clearSettledCircleAllowance(restored),/unresolved/);assert.equal(x.control.sends,1);x.control.lose=false;await clearSettledCircleAllowance(restored);assert.equal(x.control.sends,1)});
test('unknown earlier operations, unsettled debt and changed draw prevent cleanup',async()=>{for(const patch of [{oldStatus:'unknown'},{debt:1n},{draw:line},{remaining:5001n},{failSave:true}]){const x=setup();Object.assign(x.control,patch);await assert.rejects(()=>clearSettledCircleAllowance(x.options));assert.equal(x.control.sends,0)}});
test('zero allowance sends nothing and mutated saved cleanup cannot be replaced',async()=>{const x=setup();x.control.remaining=0n;assert.equal((await clearSettledCircleAllowance(x.options)).status,'no-allowance');assert.equal(x.control.sends,0);const y=setup();await clearSettledCircleAllowance(y.options);y.state.allowanceCleanup.request.data+='00';await assert.rejects(()=>clearSettledCircleAllowance(y.options),/changed/);assert.equal(y.control.sends,1)});
test('cleanup has a separate explicit confirmation command on each network',()=>{const args=['cleanup-allowance','--agent',agent,'--line',line,'--state','/tmp/original-wallet-journal'];for(const parse of [parseSettledAgentArgs,parseSettledMainnetArgs]){assert.equal(parse(args).command,'cleanup-allowance');assert.equal(parse(args).confirm,false);assert.equal(parse([...args,'--confirm']).confirm,true)}});
