import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, symlink, readdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCircleAgentJournal } from './circle-agent-journal.mjs';

test('an abrupt operator process death preserves its uncertain request and stale lock across a restored copy',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'shadow-journal-crash-')),dir=join(parent,'original'),restored=join(parent,'restored');
  try {
    const module=new URL('./circle-agent-journal.mjs',import.meta.url).href;
    const child=spawnSync(process.execPath,['--input-type=module','-e',`import {createCircleAgentJournal} from ${JSON.stringify(module)};const j=await createCircleAgentJournal(process.argv[1]);await j.withLock('wallet',async()=>{await j.put('original-request',{status:'unknown',idempotencyKey:'original-key'});process.kill(process.pid,'SIGKILL');});`,dir]);
    assert.equal(child.signal,'SIGKILL');
    await cp(dir,restored,{recursive:true});
    const a=await createCircleAgentJournal(dir),b=await createCircleAgentJournal(restored);
    for(const j of [a,b]){
      assert.deepEqual(await j.get('original-request'),{status:'unknown',idempotencyKey:'original-key'});
      await assert.rejects(()=>j.withLock('wallet',async()=>assert.fail('must not resend')),/locked/);
    }
  } finally {await rm(parent,{recursive:true,force:true});}
});
test('insecure restored directories and symlinked journal roots fail closed',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'shadow-journal-permissions-')),alias=parent+'-alias';
  try {
    await chmod(parent,0o755);await assert.rejects(()=>createCircleAgentJournal(parent),/private directory/);
    await chmod(parent,0o700);await symlink(parent,alias);await assert.rejects(()=>createCircleAgentJournal(alias),/private directory/);
  } finally {await rm(alias,{force:true});await rm(parent,{recursive:true,force:true});}
});
test('record symlinks and broadly readable restored records cannot be consumed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shadow-journal-record-'));
  try {
    const j=await createCircleAgentJournal(dir);await j.put('entry',{status:'unknown'});
    const name=(await readdir(dir))[0],path=join(dir,name);
    await chmod(path,0o644);await assert.rejects(()=>j.get('entry'),/permissions are unsafe/);
    await rm(path);const other=join(dir,'other');await writeFile(other,'{}',{mode:0o600});await symlink(other,path);
    await assert.rejects(()=>j.get('entry'));
  } finally {await rm(dir,{recursive:true,force:true});}
});
