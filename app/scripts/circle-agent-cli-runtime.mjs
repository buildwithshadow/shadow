import { realpath, mkdtemp, mkdir, writeFile, readFile, lstat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Callers verify vendor bytes before using this helper. Runtime copies are
// owner-only, writable state outside the vendor installation. Package upgrades
// and cwd changes cannot replace the verified entrypoint. Dependencies still
// resolve to the trusted isolated installation; this is not a dependency audit.
export async function freezeCircleCliSource(source, originalEntrypoint, runtimeDirectory) {
  if (!runtimeDirectory) throw new Error('An owner-controlled writable Circle runtime directory is required.');
  const original = resolve(originalEntrypoint), root = resolve(runtimeDirectory);
  await mkdir(root, {recursive:true,mode:0o700});
  const info = await lstat(root);
  if (await realpath(root) !== root || !info.isDirectory() || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) throw new Error('Circle runtime state must be an owner-controlled private directory.');
  const metadata = JSON.parse(await readFile(join(dirname(original),'..','package.json'),'utf8'));
  if (metadata.version !== '1.1.4' || metadata.type !== 'module') throw new Error('Unexpected Circle runtime package metadata.');
  const directory = await mkdtemp(join(root, 'verified-'));
  await mkdir(join(directory, 'dist'), { mode: 0o700 });
  await writeFile(join(directory, 'package.json'), JSON.stringify(metadata), { mode: 0o400, flag: 'wx' });
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
    const target=join(directory,'node_modules',dependency);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await symlink(await realpath(packageRoot),target,'dir');
  }
  const entrypoint = join(directory, 'dist', 'index.js');
  await writeFile(entrypoint, source, { mode: 0o400, flag: 'wx' });
  return entrypoint;
}
