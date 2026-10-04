import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {freezeCircleCliSource} from './circle-agent-cli-runtime.mjs';

test('execution keeps the verified bytes and version after the supplied runtime is replaced and cwd changes',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'shadow-cli-pin-'));
  const cwd=process.cwd();
  try {
    const source='import {readFileSync} from "node:fs";console.log("VERIFIED "+JSON.parse(readFileSync(new URL("../package.json",import.meta.url))).version);';
    const original=join(dir,'runtime.js');await writeFile(original,source);
    const pinned=await freezeCircleCliSource(source,relative(cwd,original));
    await writeFile(original,'throw Error("REPLACED RUNTIME");');process.chdir(dir);
    assert.equal(execFileSync(process.execPath,[pinned],{encoding:'utf8'}).trim(),'VERIFIED 1.1.4');
    assert.equal(await readFile(pinned,'utf8'),source);
    assert.equal((await stat(pinned)).mode&0o777,0o400);
    assert.equal((await stat(dirname(dirname(pinned)))).mode&0o777,0o700);
  }finally{process.chdir(cwd);await rm(dir,{recursive:true,force:true});}
});
