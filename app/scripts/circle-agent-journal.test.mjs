import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, rm, chmod, symlink, readdir, writeFile, cp, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCircleAgentJournal } from './circle-agent-journal.mjs';

test('an abrupt operator process death preserves its uncertain request and stale lock across a restored copy',async()=>{
  const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-crash-')),dir=join(parent,'original'),restored=join(parent,'restored');
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
  const parent=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-permissions-')),alias=parent+'-alias';
  try {
    await chmod(parent,0o755);await assert.rejects(()=>createCircleAgentJournal(parent),/private directory/);
    await chmod(parent,0o700);await symlink(parent,alias);await assert.rejects(()=>createCircleAgentJournal(alias),/private directory/);
  } finally {await rm(alias,{force:true});await rm(parent,{recursive:true,force:true});}
});
test('record symlinks and broadly readable restored records cannot be consumed',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'shadow-journal-record-'));
  try {
    const j=await createCircleAgentJournal(dir);await j.put('entry',{status:'unknown'});
    const name=(await readdir(dir))[0],path=join(dir,name);
    await chmod(path,0o644);await assert.rejects(()=>j.get('entry'),/permissions or size are unsafe/);
    await rm(path);const other=join(dir,'other');await writeFile(other,'{}',{mode:0o600});await symlink(other,path);
    await assert.rejects(()=>j.get('entry'));
  } finally {await rm(dir,{recursive:true,force:true});}
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
