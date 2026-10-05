import test from 'node:test';
import assert from 'node:assert/strict';
import { createCircleRunnerState } from './circle-agent-runner-state.mjs';
import { createCircleAgentJournal } from './circle-agent-journal.mjs';
import { mkdtemp, realpath, rm, rename, mkdir, symlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const agent = '0x'+'11'.repeat(20), contract = '0x'+'22'.repeat(20), line = '0x'+'33'.repeat(32);
const identity = { agent, contract, line };
const purchase = (lineId = line) => JSON.stringify({ account:agent, contract, chainId:5042002, intent:{ typedData:{ message:{ agent, lineId } } } });
function memory() {
  const data = new Map();
  return {data, get:async key => structuredClone(data.get(key) ?? null), put:async(key,value)=>data.set(key,structuredClone(value))};
}
test('runner storage persists queued snapshots in order before a side effect',async()=>{
 const journal=memory(), runner=await createCircleRunnerState({journal,...identity});
 runner.storage.setItem('purchase',purchase());
 runner.state.requests.purchase={key:'original'};
 await runner.save();
 const reloaded=await createCircleRunnerState({journal,...identity});
 assert.equal(reloaded.storage.getItem('purchase'),purchase());
 assert.equal(reloaded.state.requests.purchase.key,'original');
 runner.storage.setItem('archive',purchase());runner.storage.removeItem('purchase');await runner.flush();
 assert.equal((await createCircleRunnerState({journal,...identity})).storage.getItem('purchase'),null);
 assert.equal(journal.data.get(runner.key).storage.archive,purchase());
});
test('wrong funding line is refused on load and before a write can be queued',async()=>{
 const journal=memory(), runner=await createCircleRunnerState({journal,...identity});
 assert.throws(()=>runner.storage.setItem('purchase',purchase('0x'+'44'.repeat(32))),/another funding line/);
 assert.equal(journal.data.size,0);
 const invalid={version:1,...identity,chainId:5042002,storage:{purchase:purchase('0x'+'44'.repeat(32))},requests:{}};
 journal.data.set(runner.key,invalid);
 await assert.rejects(createCircleRunnerState({journal,...identity}),/another funding line/);
});
test('failed durability remains sticky and prevents the next side effect',async()=>{
 const journal=memory(), runner=await createCircleRunnerState({journal,...identity});
 journal.put=async()=>{throw Error('checkpoint failed');};
 runner.storage.setItem('purchase',purchase());
 let sends=0;
 async function send(){await runner.flush();sends++;}
 await assert.rejects(send(),/checkpoint failed/);
 await assert.rejects(runner.flush(),/checkpoint failed/);
 assert.throws(()=>runner.storage.removeItem('purchase'),/checkpoint failed/);
 assert.equal(sends,0);
});
test('runner writes stay in the verified directory after its configured path is replaced',async t=>{
 const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-runner-state-'));
 const root=join(parent,'journal'), original=join(parent,'original'), attacker=join(parent,'attacker');
 const journal=await createCircleAgentJournal(root,{identityDirectory:join(parent,'identities')});
 t.after(async()=>{journal.close();await rm(parent,{recursive:true,force:true});});
 const runner=await createCircleRunnerState({journal,...identity});
 assert.equal(await journal.hasLegacyRunnerState(agent,line),false);
 const legacy=`purchase-${agent}-${line}.json`;
 await writeFile(join(root,legacy),'unresolved legacy purchase',{mode:0o600});
 await rename(root,original);await mkdir(attacker,{mode:0o700});await symlink(attacker,root,'dir');
 assert.equal(await journal.hasLegacyRunnerState(agent,line),true,'replacement path cannot hide an unresolved legacy purchase');
 runner.storage.setItem('purchase',purchase());await runner.flush();
 const filename=createHash('sha256').update(runner.key).digest('hex')+'.json';
 assert.equal(JSON.parse(await readFile(join(original,filename),'utf8')).storage.purchase,purchase());
 await assert.rejects(readFile(join(root,filename)),{code:'ENOENT'});
});
test('restoring an earlier runner file cannot remove a recorded execution request',async t=>{
 const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-runner-rollback-'));
 const root=join(parent,'journal');
 const journal=await createCircleAgentJournal(root,{identityDirectory:join(parent,'identities')});
 t.after(async()=>{journal.close();await rm(parent,{recursive:true,force:true});});
 const runner=await createCircleRunnerState({journal,...identity});
 runner.storage.setItem('purchase',purchase());await runner.flush();
 const filename=join(root,createHash('sha256').update(runner.key).digest('hex')+'.json');
 const old=await readFile(filename);
 runner.state.requests.purchase={key:'paid-request'};await runner.save();
 await writeFile(filename,old);
 await assert.rejects(createCircleRunnerState({journal,...identity}),/checkpoint|changed|rollback|match/i);
});
