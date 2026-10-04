import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,stat,rm,mkdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {freezeCircleCliSource} from './circle-agent-cli-runtime.mjs';

test('execution keeps the verified bytes and version after the supplied runtime is replaced and cwd changes',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'shadow-cli-pin-'));
  const cwd=process.cwd();
  try {
    const source='import {readFileSync} from "node:fs";console.log("VERIFIED "+JSON.parse(readFileSync(new URL("../package.json",import.meta.url))).version);';
    await mkdir(join(dir,'vendor','dist'),{recursive:true});
    await writeFile(join(dir,'vendor','package.json'),JSON.stringify({name:'@circle-fin/cli',version:'1.1.4',type:'module'}));
    const original=join(dir,'vendor','dist','index.js');await writeFile(original,source);
    const pinned=await freezeCircleCliSource(source,relative(cwd,original),join(dir,'state'));
    await writeFile(original,'throw Error("REPLACED RUNTIME");');process.chdir(dir);
    assert.equal(execFileSync(process.execPath,[pinned],{encoding:'utf8'}).trim(),'VERIFIED 1.1.4');
    assert.equal(await readFile(pinned,'utf8'),source);
    assert.equal((await stat(pinned)).mode&0o777,0o400);
    assert.equal((await stat(dirname(dirname(pinned)))).mode&0o777,0o700);
  }finally{process.chdir(cwd);await rm(dir,{recursive:true,force:true});}
});


test('read-only vendor installations use separate private writable state',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'shadow-cli-readonly-'));
  const vendor=join(dir,'vendor');
  try{
    await mkdir(join(vendor,'dist'),{recursive:true});
    await writeFile(join(vendor,'package.json'),JSON.stringify({name:'@circle-fin/cli',version:'1.1.4',type:'module'}));
    const original=join(vendor,'dist','index.js'),source='console.log("READ_ONLY_VENDOR");';await writeFile(original,source);
    await chmod(vendor,0o500);await chmod(join(vendor,'dist'),0o500);await chmod(original,0o400);
    const pinned=await freezeCircleCliSource(source,original,join(dir,'state'));
    assert(!pinned.startsWith(vendor+'/'));assert.equal(execFileSync(process.execPath,[pinned],{encoding:'utf8'}).trim(),'READ_ONLY_VENDOR');
  }finally{await chmod(vendor,0o700);await chmod(join(vendor,'dist'),0o700);await rm(dir,{recursive:true,force:true});}
});


test('import-only dependencies retain their installed package identity outside the vendor tree',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'shadow-cli-esm-'));
  try{
    await mkdir(join(dir,'vendor','dist'),{recursive:true});await mkdir(join(dir,'node_modules','import-only'),{recursive:true});
    await writeFile(join(dir,'vendor','package.json'),JSON.stringify({version:'1.1.4',type:'module',dependencies:{'import-only':'1.0.0'}}));
    await writeFile(join(dir,'node_modules','import-only','package.json'),JSON.stringify({name:'import-only',version:'1.0.0',type:'module',exports:{'.':{import:'./index.js'}}}));
    await writeFile(join(dir,'node_modules','import-only','index.js'),'export default "IMPORT_ONLY_VERIFIED";');
    const original=join(dir,'vendor','dist','index.js'),source='import value from "import-only";console.log(value);';await writeFile(original,source);
    const pinned=await freezeCircleCliSource(source,original,join(dir,'state'));
    assert.equal(execFileSync(process.execPath,[pinned],{encoding:'utf8'}).trim(),'IMPORT_ONLY_VERIFIED');
  }finally{await rm(dir,{recursive:true,force:true});}
});
