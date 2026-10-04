import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupCircleAgentWallet } from './circle-agent-setup.mjs';
import { createCircleCliDriver } from './circle-agent-cli-transport.mjs';
import { parseAgentArgs } from './shadow-circle-agent.mjs';
const agent = `0x${'11'.repeat(20)}`;
function fixture() {
  const data = new Map(), events = [];
  const state = { chain:5042002,code:'0x',balance:10n**18n,fee:'0.001',error:null,deploy:true,sessionError:false };
  const journal = {get:async key=>data.get(key),put:async(key,value)=>{events.push('persist');data.set(key,value);},withLock:async(key,fn)=>{events.push(['lock',key]);return fn();}};
  const client = {getChainId:async()=>state.chain,getCode:async request=>{assert.equal(request.blockTag,'finalized');return state.code;},getBalance:async()=>state.balance};
  const circle = {session:async()=>{if(state.sessionError)throw new Error('expired');},estimateActivation:async()=>{events.push('estimate');return {networkFee:state.fee};},activate:async()=>{events.push('send');if(state.error)throw state.error;if(state.deploy)state.code='0x1234';return {untrusted:'not printed'};}};
  return {state,data,events,client,circle,journal,run:(confirm=false)=>setupCircleAgentWallet({agent,client,circle,journal,confirm})};
}
test('setup parsing requires an agent but no line, and supports explicit confirmation',()=>{
  assert.equal(parseAgentArgs(['setup','--agent',agent]).confirm,false);
  assert.equal(parseAgentArgs(['setup','--agent',agent,'--confirm']).confirm,true);
  assert.throws(()=>parseAgentArgs(['setup']));
  assert.throws(()=>parseAgentArgs(['doctor','--agent',agent,'--confirm']));
});
test('deployed wallet and unfunded wallet require no estimate or submission',async()=>{
  const x=fixture();x.state.code='0x1234';
  assert.equal((await x.run(true)).status,'ready');assert(!x.events.includes('estimate'));assert(!x.events.includes('send'));
  x.state.code='0x';x.state.balance=0n;
  assert.equal((await x.run(true)).status,'needs-funding');assert(!x.events.includes('send'));
});
test('default setup estimates a self-transfer but never persists an attempt or sends',async()=>{
  const x=fixture(),result=await x.run();
  assert.equal(result.status,'review');assert.equal(result.activation.amount,'0');assert.equal(result.activation.to,agent);
  assert.equal(result.sent,false);assert.equal(x.data.size,0);assert(!x.events.includes('send'));
});
test('confirmed setup persists before sending, verifies finalized code, and never repeats',async()=>{
  const x=fixture();let r=await x.run(true);
  assert.equal(r.status,'ready');assert.equal(r.sent,true);assert(x.events.indexOf('persist')<x.events.indexOf('send'));
  r=await x.run(true);assert.equal(r.sent,false);assert.equal(x.events.filter(x=>x==='send').length,1);
});
test('timeout stays held across repeated confirmed calls; later code observation recovers without resend',async()=>{
  const x=fixture();x.state.error=new Error('network timeout');
  assert.equal((await x.run(true)).status,'unknown');
  assert.equal((await x.run(true)).status,'unknown');assert.equal(x.events.filter(x=>x==='send').length,1);
  x.state.code='0x1234';assert.equal((await x.run()).status,'ready');assert.equal(x.events.filter(x=>x==='send').length,1);
});
test('successful response without finalized code remains held',async()=>{
  const x=fixture();x.state.deploy=false;
  assert.equal((await x.run(true)).status,'unknown');await x.run(true);
  assert.equal(x.events.filter(x=>x==='send').length,1);
});
test('definite pre-submit session failure permits a new explicit attempt',async()=>{
  const x=fixture();x.state.error=Object.assign(new Error('expired'),{beforeSubmission:true});
  assert.equal((await x.run(true)).status,'not-submitted');
  x.state.error=null;assert.equal((await x.run()).status,'review');
  assert.equal((await x.run(true)).status,'ready');
});
test('wrong network, invalid session and outstanding executor operation prevent send',async()=>{
  const x=fixture();x.state.chain=5042;await assert.rejects(()=>x.run(true),/testnet only/);
  x.state.chain=5042002;x.state.sessionError=true;await assert.rejects(()=>x.run(true),/expired/);
  x.state.sessionError=false;await x.run();
  const namespace=x.events.find(Array.isArray)[1];x.data.set(`${namespace}:active`,'pending');
  await assert.rejects(()=>x.run(true),/outstanding Circle operation/);assert(!x.events.includes('send'));
});
test('malformed, excessive and unaffordable estimates prevent activation',async()=>{
  for(const fee of ['NaN','-1','1e-3','0.100001',undefined]) {
    const x=fixture();x.state.fee=fee;await assert.rejects(()=>x.run(true));assert(!x.events.includes('send'));
  }
  const x=fixture();x.state.balance=1n;await assert.rejects(()=>x.run(true),/Insufficient/);assert(!x.events.includes('send'));
});
test('persistence failure prevents send and RPC failure after send leaves the durable hold',async()=>{
  const x=fixture();x.journal.put=async()=>{throw new Error('disk full');};
  await assert.rejects(()=>x.run(true),/disk full/);assert(!x.events.includes('send'));
  const y=fixture();y.circle.activate=async()=>{y.events.push('send');y.client.getCode=async()=>{throw new Error('RPC unavailable');};};
  assert.equal((await y.run(true)).status,'unknown');assert.equal(y.data.size,1);
});
test('transport activation uses original Circle CLI, exact self-address, zero value and fresh session',async()=>{
  const calls=[];let valid=true;
  const run=async(_node,args)=>{calls.push(args);
    if(args.includes('status'))return {stdout:JSON.stringify({data:{testnet:{tokenStatus:valid?'VALID':'EXPIRED'}}})};
    if(args.includes('list'))return {stdout:JSON.stringify({data:[{address:agent}]})};
    return {stdout:JSON.stringify({data:{blockchain:'ARC-TESTNET',medium:{networkFee:'0.002'}}})};
  };
  const circle=createCircleCliDriver({entrypoint:'/original.js',compatibility:'/patched.js',agent,journal:{},run});
  assert.equal((await circle.estimateActivation()).networkFee,'0.002');
  const key='11111111-1111-4111-8111-111111111111';await circle.activate({idempotencyKey:key});
  const transfers=calls.filter(a=>a.includes('transfer'));assert.equal(transfers.length,2);
  for(const args of transfers) {assert.equal(args[0],'/original.js');assert.equal(args[3],agent);assert.equal(args[args.indexOf('--amount')+1],'0');assert.equal(args[args.indexOf('--address')+1],agent);assert.equal(args[args.indexOf('--chain')+1],'ARC-TESTNET');}
  assert(transfers[0].includes('--estimate'));assert(transfers[1].includes(key));
  valid=false;await assert.rejects(()=>circle.activate({idempotencyKey:key}),e=>e.beforeSubmission===true);
  assert.equal(calls.filter(a=>a.includes('transfer')).length,2);
});
test('late balance or deployment changes are checked before the submission barrier',async()=>{
  const x=fixture();x.circle.estimateActivation=async()=>{x.state.balance=0n;return {networkFee:'0.001'};};
  await assert.rejects(()=>x.run(true),/balance changed/);assert.equal(x.data.size,0);assert(!x.events.includes('send'));
  const y=fixture();y.circle.estimateActivation=async()=>{y.state.code='0x1234';return {networkFee:'0.001'};};
  assert.equal((await y.run(true)).status,'ready');assert.equal(y.data.size,0);assert(!y.events.includes('send'));
});
test('journal records cannot silently switch wallet identity',async()=>{
  const x=fixture();x.state.deploy=false;await x.run(true);
  const [key,record]=[...x.data.entries()][0];x.data.set(key,{...record,agent:`0x${'22'.repeat(20)}`});
  await assert.rejects(()=>x.run(true),/journal identity/);assert.equal(x.events.filter(x=>x==='send').length,1);
});
test('activation holds across journal recreation and competing instances cannot submit twice',async()=>{
  const {mkdtemp,rm,realpath}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {createCircleAgentJournal}=await import('./circle-agent-journal.mjs');
  const dir=await mkdtemp(join(await realpath(tmpdir()),'shadow-activation-'));
  try {
    const x=fixture();let release,entered;const gate=new Promise(r=>{release=r;});const started=new Promise(r=>{entered=r;});
    x.circle.activate=async()=>{x.events.push('send');entered();await gate;throw new Error('lost response');};
    const first=setupCircleAgentWallet({agent,client:x.client,circle:x.circle,journal:await createCircleAgentJournal(dir),confirm:true});
    await started;
    x.journal2=await createCircleAgentJournal(dir);
    try { await assert.rejects(()=>setupCircleAgentWallet({agent,client:x.client,circle:x.circle,journal:x.journal2,confirm:true}),/locked/); }
    finally { release(); }
    assert.equal((await first).status,'unknown');
    const next=await setupCircleAgentWallet({agent,client:x.client,circle:x.circle,journal:await createCircleAgentJournal(dir),confirm:true});
    assert.equal(next.status,'unknown');assert.equal(x.events.filter(x=>x==='send').length,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});
