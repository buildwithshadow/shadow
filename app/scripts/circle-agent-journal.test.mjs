import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, rm, chmod, symlink, readdir, readFile, writeFile, cp, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCircleAgentJournal } from './circle-agent-journal.mjs';

test('an abrupt operator process death preserves its uncertain request and stale lock across a restored copy',async()=>{
  const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-crash-')),dir=join(parent,'original'),restored=join(parent,'restored');
  try {
    const module=new URL('./circle-agent-journal.mjs',import.meta.url).href;
    const child=spawnSync(process.execPath,['--input-type=module','-e',`import {createCircleAgentJournal} from ${JSON.stringify(module)};const j=await createCircleAgentJournal(process.argv[1],{identityDirectory:process.argv[2]});await j.withLock('wallet',async()=>{await j.put('original-request',{status:'unknown',idempotencyKey:'original-key'});process.kill(process.pid,'SIGKILL');});`,dir,join(parent,'identities')]);
    assert.equal(child.signal,'SIGKILL');
    await cp(dir,restored,{recursive:true});
    const a=await createCircleAgentJournal(dir,{identityDirectory:join(parent,'identities')});
    await assert.rejects(()=>createCircleAgentJournal(restored),/explicit reconciliation/);
    for(const j of [a]){
      assert.deepEqual(await j.get('original-request'),{status:'unknown',idempotencyKey:'original-key'});
      await assert.rejects(()=>j.withLock('wallet',async()=>assert.fail('must not resend')),/locked/);
    }
  } finally {await rm(parent,{recursive:true,force:true});}
});
test('insecure restored directories and symlinked journal roots fail closed',async()=>{
  const sandbox=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-permissions-')),parent=join(sandbox,'journal'),alias=join(sandbox,'alias');await mkdir(parent,{mode:0o700});
  try {
    await chmod(parent,0o755);await assert.rejects(()=>createCircleAgentJournal(parent),/private directory/);
    await chmod(parent,0o700);await symlink(parent,alias);await assert.rejects(()=>createCircleAgentJournal(alias),/private directory/);
  } finally {await rm(sandbox,{recursive:true,force:true});}
});
test('record symlinks and broadly readable restored records cannot be consumed',async()=>{
  const sandbox=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-record-')),dir=join(sandbox,'journal');
  try {
    const j=await createCircleAgentJournal(dir);await j.put('entry',{status:'unknown'});
    const name=(await readdir(dir)).find(name=>/^[a-f0-9]{64}\.json$/.test(name)),path=join(dir,name);
    await chmod(path,0o644);await assert.rejects(()=>j.get('entry'),/permissions or size are unsafe/);
    await rm(path);const other=join(dir,'other');await writeFile(other,'{}',{mode:0o600});await symlink(other,path);
    await assert.rejects(()=>j.get('entry'));
  } finally {await rm(sandbox,{recursive:true,force:true});}
});


test('intermediate aliases are refused and retargeting an opened directory retains its original barrier',async()=>{
  const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-alias-'));
  try {
    const original=join(parent,'original'),replacement=join(parent,'replacement'),alias=join(parent,'alias');
    await mkdir(original,{mode:0o700});await mkdir(replacement,{mode:0o700});
    const j=await createCircleAgentJournal(join(original,'private'));await j.put('wallet',{status:'unknown'});
    await symlink(original,alias);
    await assert.rejects(()=>createCircleAgentJournal(join(alias,'private')),/symlinked path/);
    await rename(original,join(parent,'moved'));await symlink(replacement,original);
    assert.deepEqual(await j.get('wallet'),{status:'unknown'});
    await j.put('original-only',{preserved:true});
    assert.deepEqual(await j.get('original-only'),{preserved:true});
    assert.deepEqual(await readdir(replacement),[]);
    j.close();
  } finally {await rm(parent,{recursive:true,force:true});}
});


test('a new ordinary directory at the old path cannot silently reset another operator’s journal identity',async()=>{
  const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-replacement-')),dir=join(parent,'active');
  try{
    const original=await createCircleAgentJournal(dir);await original.put('wallet',{status:'unknown',request:'original'});
    await rename(dir,join(parent,'original'));await mkdir(dir,{mode:0o700});
    await assert.rejects(()=>createCircleAgentJournal(dir),/root was replaced/);
    assert.deepEqual(await original.get('wallet'),{status:'unknown',request:'original'});
    original.close();
  }finally{await rm(parent,{recursive:true,force:true});}
});


test('identity state rejects non-sticky shared-writable ancestors',async()=>{
 const sandbox=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-parent-'));
 try{await chmod(sandbox,0o777);await assert.rejects(()=>createCircleAgentJournal(join(sandbox,'journal'),{identityDirectory:join(sandbox,'identities')}),/unsafe writable ancestor/);}
 finally{await chmod(sandbox,0o700);await rm(sandbox,{recursive:true,force:true});}
});


test('a private journal beneath a shared mount can use separate trusted identity state',async()=>{
 const sandbox=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-mount-'));
 try{
  const shared=join(sandbox,'shared'),state=join(sandbox,'state');await mkdir(shared,{mode:0o777});await chmod(shared,0o777);
  const dir=join(shared,'journal'),j=await createCircleAgentJournal(dir,{identityDirectory:state});
  await j.put('request',{status:'unknown'});assert.deepEqual(await j.get('request'),{status:'unknown'});
  await rename(dir,join(shared,'old'));await mkdir(dir,{mode:0o700});
  await assert.rejects(()=>createCircleAgentJournal(dir,{identityDirectory:state}),/root was replaced/);j.close();
 }finally{await rm(sandbox,{recursive:true,force:true});}
});


test('restoring an older record in place cannot erase an uncertain operation', async () => {
 const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-rollback-')),dir=join(parent,'journal');
 const options={identityDirectory:join(parent,'identities')};let first,second;
 try {
  first=await createCircleAgentJournal(dir,options);
  await first.put('wallet:active',{status:'idle'});
  const name=(await readdir(dir)).find(name=>/^[a-f0-9]{64}\.json$/.test(name));
  const backup=await readFile(join(dir,name));
  await first.put('wallet:active',{status:'unknown',idempotencyKey:'fixture-key'});
  first.close();
  await writeFile(join(dir,name),backup,{mode:0o600});
  second=await createCircleAgentJournal(dir,options);
  await assert.rejects(()=>second.get('wallet:active'),/rollback/);
  await assert.rejects(()=>second.put('wallet:active',{status:'idle'}),/rollback/);
 } finally {first?.close();second?.close();await rm(parent,{recursive:true,force:true});}
});

test('deleted records and root identities cannot be silently initialized', async () => {
 const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-deleted-')),dir=join(parent,'journal');
 const options={identityDirectory:join(parent,'identities')};let first,second;
 try {
  first=await createCircleAgentJournal(dir,options);
  await first.put('wallet:active',{status:'unknown'});first.close();
  for(const name of await readdir(dir))if(name!=='.root-token')await rm(join(dir,name));
  second=await createCircleAgentJournal(dir,options);
  await assert.rejects(()=>second.get('wallet:active'),/rollback/);second.close();
  await rm(join(dir,'.root-token'));
  await assert.rejects(()=>createCircleAgentJournal(dir,options),/root was replaced/);
 } finally {first?.close();second?.close();await rm(parent,{recursive:true,force:true});}
});

test('death after checkpoint persistence but before the journal write cannot reopen the barrier', async () => {
 const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-checkpoint-crash-')),dir=join(parent,'journal');
 const identities=join(parent,'identities');let journal;
 try {
  journal=await createCircleAgentJournal(dir,{identityDirectory:identities});
  await journal.put('wallet:active',{status:'idle'});
  const name=(await readdir(dir)).find(name=>/^[a-f0-9]{64}\.json$/.test(name));
  const records=join(identities,(await readdir(identities)).find(name=>name.endsWith('.records')));
  const module=new URL('./circle-agent-journal-checkpoint.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {checkpointRecord} from ${JSON.stringify(module)};await checkpointRecord(process.argv[1],process.argv[2],async(_before,commit)=>{await commit(Buffer.from(JSON.stringify({status:'unknown'})));process.kill(process.pid,'SIGKILL');});`,records,name],{cwd:dir});
  assert.equal(child.signal,'SIGKILL');
  await assert.rejects(()=>journal.get('wallet:active'),/checkpoint is locked/);
  // Fixture-only removal of the proven dead writer's lock still must not
  // permit use of the old record. Production recovery needs reconciliation.
  await rm(join(records,`${name}.checkpoint.lock`));
  await assert.rejects(()=>journal.get('wallet:active'),/rollback/);
 } finally {journal?.close();await rm(parent,{recursive:true,force:true});}
});


test('identity checkpoints cannot share the journal rollback boundary', async () => {
 const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-overlap-'));
 try {
  for(const nested of ['', 'checkpoints', 'nested/checkpoints']) {
   const dir=join(parent,'journal');
   await assert.rejects(()=>createCircleAgentJournal(dir,{identityDirectory:join(dir,nested)}),/outside the journal root/);
   assert.deepEqual(await readdir(dir),[], 'invalid configuration must not initialize identity state inside the root');
  }
 } finally {await rm(parent,{recursive:true,force:true});}
});

test('another fresh root cannot bypass an unresolved wallet operation', async () => {
 const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-wallet-roots-'));
 const options={identityDirectory:join(parent,'identities')};let a,b,c;
 try {
  a=await createCircleAgentJournal(join(parent,'original'),options);
  b=await createCircleAgentJournal(join(parent,'fresh'),options);
  await a.withLock('wallet-namespace',()=>a.put('wallet-namespace:active',{status:'unknown',idempotencyKey:'original'}));
  await assert.rejects(()=>b.withLock('wallet-namespace',async()=>assert.fail('fresh root must not reach send')),/another journal root/);
  await b.withLock('different-wallet',async()=>{});
  c=await createCircleAgentJournal(join(parent,'original'),options);
  await c.withLock('wallet-namespace',async()=>assert.deepEqual(await c.get('wallet-namespace:active'),{status:'unknown',idempotencyKey:'original'}));
 } finally {a?.close();b?.close();c?.close();await rm(parent,{recursive:true,force:true});}
});

test('concurrent fresh roots cannot both claim the same wallet namespace',async()=>{
 const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-wallet-root-race-'));
 const options={identityDirectory:join(parent,'identities')};let a,b;
 try{
  a=await createCircleAgentJournal(join(parent,'a'),options);b=await createCircleAgentJournal(join(parent,'b'),options);
  let calls=0;
  const results=await Promise.allSettled([a.withLock('same-wallet',async()=>{calls++;}),b.withLock('same-wallet',async()=>{calls++;})]);
  assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 }finally{a?.close();b?.close();await rm(parent,{recursive:true,force:true});}
});

test('concurrent same-root registration never exposes a partial wallet binding',async()=>{
 const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-wallet-same-root-'));
 const options={identityDirectory:join(parent,'identities')};let a,b;
 try{
  a=await createCircleAgentJournal(join(parent,'journal'),options);
  b=await createCircleAgentJournal(join(parent,'journal'),options);
  for(let i=0;i<20;i++){
   const key=`same-wallet-${i}`;
   const results=await Promise.allSettled([a.withLock(key,async()=>{}),b.withLock(key,async()=>{})]);
   assert.ok(results.some(r=>r.status==='fulfilled'));
   for(const result of results)if(result.status==='rejected')assert.match(result.reason.message,/locked/);
   await a.withLock(key,async()=>{});
  }
 }finally{a?.close();b?.close();await rm(parent,{recursive:true,force:true});}
});
