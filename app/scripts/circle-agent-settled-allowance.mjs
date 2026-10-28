import {encodeFunctionData,erc20Abi,keccak256,encodeAbiParameters} from 'viem';
const must=(ok,message)=>{if(!ok)throw Error(message)};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const USDC='0x3600000000000000000000000000000000000000';
/** Call under the original runner lock. Cleanup is a distinct, durable zero
 * approval; it never reinterprets repayment records or approves another amount. */
export async function clearSettledCircleAllowance({agent,line,contract,state,save,operations,readLine,readAllowance,makeResetter}){
 const plan=state.guardedRepayment;
 must(plan?.version===1&&same(plan.line,line)&&/^0x[0-9a-fA-F]{64}$/.test(plan.draw)&&!/^0x0{64}$/.test(plan.draw)
  &&/^[1-9][0-9]*$/.test(plan.amount)&&BigInt(plan.amount)<=50000n,'Preserve the original bounded repayment plan before allowance cleanup.');
 for(const record of Object.values(state.requests)){
  const result=await operations.reconcile(record.key);
  must(['confirmed','blocked','not-submitted'].includes(result.status),'Reconcile the earlier Circle operation before cleanup.');
 }
 const resetter=await makeResetter(plan);
 const request={operationId:`allowance-reset:${keccak256(encodeAbiParameters([{type:"bytes32"},{type:"bytes32"}],[line,plan.draw]))}`,to:USDC,value:'0',
  data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[contract,0n]})};
 const reviewed={version:1,draw:plan.draw,request,key:resetter.operationKey(request)};
 const prior=state.allowanceCleanup;
 if(prior){
  must(JSON.stringify(prior)===JSON.stringify(reviewed),'Saved allowance cleanup changed. Preserve its original record.');
  const result=await resetter.reconcile(prior.key);
  must(result.status==='confirmed','Original allowance cleanup remains unresolved; no replacement was sent.');
  must(await readAllowance()===0n,'Allowance changed after the original cleanup. Review it separately.');
  return result;
 }
 const current=await readLine();
 must(same(current.agent,agent)&&same(current.drawDigest,plan.draw)&&current.principalOutstanding===0n,'Cleanup requires the original agent draw to be fully settled.');
 const remaining=await readAllowance();
 must(typeof remaining==='bigint'&&remaining>=0n&&remaining<=BigInt(plan.amount),'Unexpected allowance exceeds the original reviewed maximum.');
 if(remaining===0n)return {status:'no-allowance'};
 state.allowanceCleanup=reviewed;await save();
 const result=await resetter.execute(request);
 must(result.status==='confirmed','Allowance cleanup remains unresolved; recover this original cleanup before another action.');
 must(await readAllowance()===0n,'Allowance is not zero after the verified cleanup.');
 return result;
}
