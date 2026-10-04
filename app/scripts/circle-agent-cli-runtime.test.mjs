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


test('repeated construction reuses the validated source cache and altered cached bytes fail closed',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'shadow-cli-cache-'));
 try{
  await mkdir(join(dir,'vendor','dist'),{recursive:true});await writeFile(join(dir,'vendor','package.json'),JSON.stringify({version:'1.1.4',type:'module'}));
  const original=join(dir,'vendor','dist','index.js'),source='console.log("CACHED");',state=join(dir,'state');await writeFile(original,source);
  const first=await freezeCircleCliSource(source,original,state);assert.equal(await freezeCircleCliSource(source,original,state),first);
  await chmod(first,0o600);await writeFile(first,'throw Error("tampered");');await chmod(first,0o400);
  await assert.rejects(()=>freezeCircleCliSource(source,original,state),/source changed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('direct and transitive imports stay frozen after installed packages are replaced',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'shadow-cli-dependencies-'));
 try{
  const vendor=join(dir,'vendor'),modules=join(dir,'node_modules');
  await mkdir(join(vendor,'dist'),{recursive:true});
  await writeFile(join(vendor,'package.json'),JSON.stringify({version:'1.1.4',type:'module',dependencies:{direct:'1'}}));
  for(const name of ['direct','transitive'])await mkdir(join(modules,name),{recursive:true});
  await writeFile(join(modules,'direct','package.json'),JSON.stringify({name:'direct',version:'1',type:'module',exports:'./index.js',dependencies:{transitive:'1'}}));
  await writeFile(join(modules,'transitive','package.json'),JSON.stringify({name:'transitive',version:'1',type:'module',exports:'./index.js'}));
  await writeFile(join(modules,'direct','index.js'),'import v from "transitive";export default "DIRECT_"+v;');
  await writeFile(join(modules,'transitive','index.js'),'export default "ORIGINAL";');
  const source='import v from "direct";console.log(v);',original=join(vendor,'dist','index.js');await writeFile(original,source);
  const pinned=await freezeCircleCliSource(source,original,join(dir,'state'));
  await writeFile(join(modules,'direct','index.js'),'throw Error("MUTABLE DIRECT");');
  await rm(join(modules,'transitive'),{recursive:true});await mkdir(join(modules,'transitive'));
  await writeFile(join(modules,'transitive','package.json'),JSON.stringify({name:'transitive',version:'2',type:'module',exports:'./index.js'}));
  await writeFile(join(modules,'transitive','index.js'),'throw Error("REPLACED TRANSITIVE");');
  assert.equal(execFileSync(process.execPath,[pinned],{encoding:'utf8'}).trim(),'DIRECT_ORIGINAL');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a changed cached dependency fails validation before cache reuse',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'shadow-cli-cache-dep-'));
 try{
  await mkdir(join(dir,'vendor','dist'),{recursive:true});await mkdir(join(dir,'node_modules','dependency'),{recursive:true});
  await writeFile(join(dir,'vendor','package.json'),JSON.stringify({version:'1.1.4',type:'module',dependencies:{dependency:'1'}}));
  await writeFile(join(dir,'node_modules','dependency','package.json'),JSON.stringify({name:'dependency',version:'1',type:'module',exports:'./index.js'}));
  await writeFile(join(dir,'node_modules','dependency','index.js'),'export default 1;');
  const original=join(dir,'vendor','dist','index.js'),source='import value from "dependency";console.log(value);';await writeFile(original,source);
  const pinned=await freezeCircleCliSource(source,original,join(dir,'state'));
  const dependency=await realpath(join(dirname(dirname(pinned)),'node_modules','dependency','index.js'));
  await chmod(dependency,0o600);await writeFile(dependency,'export default 2;');await chmod(dependency,0o400);
  await assert.rejects(()=>freezeCircleCliSource(source,original,join(dir,'state')),/source changed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
