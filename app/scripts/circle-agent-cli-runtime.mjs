import { realpath, mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rename, rm, readlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { requirePrivateState } from './circle-agent-private-state.mjs';

// Callers verify vendor bytes before using this helper. Runtime copies are
// owner-only, writable state outside the vendor installation. Package upgrades
// and cwd changes cannot replace the verified entrypoint. Dependencies still
// resolve to the trusted isolated installation; this is not a dependency audit.
export async function freezeCircleCliSource(source, originalEntrypoint, runtimeDirectory) {
  if (!runtimeDirectory) throw new Error('An owner-controlled writable Circle runtime directory is required.');
  const original = resolve(originalEntrypoint), root = await requirePrivateState(runtimeDirectory);
  const metadata = JSON.parse(await readFile(join(dirname(original),'..','package.json'),'utf8'));
  if (metadata.version !== '1.1.4' || metadata.type !== 'module') throw new Error('Unexpected Circle runtime package metadata.');
  const links=[];
  const dependencies = {...metadata.dependencies,...metadata.optionalDependencies};
  const require = createRequire(original);
  for (const dependency of Object.keys(dependencies)) {
    let packageRoot;
    for(const base of require.resolve.paths(dependency) ?? []){
      const candidate=join(base,dependency);let pkg;
      try{pkg=JSON.parse(await readFile(join(candidate,'package.json'),'utf8'));}catch{}
      if(pkg?.name===dependency){packageRoot=candidate;break;}
    }
    if(!packageRoot){
      if(dependency in (metadata.optionalDependencies??{}))continue;
      throw new Error('Circle dependency package identity unavailable.');
    }
    links.push([dependency,await realpath(packageRoot)]);
  }
  const hash = createHash('sha256').update(source).update(JSON.stringify(metadata)).update(JSON.stringify(links)).digest('hex');
  const directory = join(root, `verified-${hash}`);
  async function validate(){
    const folder=await lstat(directory);
    if(!folder.isDirectory()||folder.isSymbolicLink()||(folder.mode&0o077)!==0||(process.getuid&&folder.uid!==process.getuid()))throw new Error('Verified Circle cache permissions are unsafe.');
    const file=join(directory,'dist','index.js'),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o777)!==0o400||(process.getuid&&info.uid!==process.getuid())
        || !Buffer.from(await readFile(file)).equals(Buffer.from(source)))throw new Error('Verified Circle cache source changed.');
    const packageInfo=await lstat(join(directory,'package.json')),dist=await lstat(join(directory,'dist'));
    if(!packageInfo.isFile()||packageInfo.isSymbolicLink()||(packageInfo.mode&0o777)!==0o400
        ||!dist.isDirectory()||dist.isSymbolicLink()||(dist.mode&0o077)!==0
        ||(process.getuid&&(packageInfo.uid!==process.getuid()||dist.uid!==process.getuid()))
        ||await readFile(join(directory,'package.json'),'utf8')!==JSON.stringify(metadata))throw new Error('Verified Circle cache metadata changed.');
    for(const [name,target] of links)if(await readlink(join(directory,'node_modules',name))!==target)throw new Error('Verified Circle cache dependency changed.');
    return file;
  }
  try{return await validate();}catch(error){if(error.code!=='ENOENT')throw error;}
  const staging=await mkdtemp(join(root,'building-'));
  try{
    await mkdir(join(staging,'dist'),{mode:0o700});
    await writeFile(join(staging,'package.json'),JSON.stringify(metadata),{mode:0o400,flag:'wx'});
    for(const [name,target] of links){const link=join(staging,'node_modules',name);await mkdir(dirname(link),{recursive:true,mode:0o700});await symlink(target,link,'dir');}
    await writeFile(join(staging,'dist','index.js'),source,{mode:0o400,flag:'wx'});
    try{await rename(staging,directory);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
    return await validate();
  }finally{await rm(staging,{recursive:true,force:true});}
}
