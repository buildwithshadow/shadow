import { realpath, mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rename, rm, readlink, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { requirePrivateState } from './circle-agent-private-state.mjs';

import approval from './circle-cli-dependency-approval.json' with { type: 'json' };
export const APPROVED_CIRCLE_DEPENDENCY_DIGEST = approval.runtimes?.find(record=>record.platform===process.platform && record.arch===process.arch)?.dependencyDigest;

const hashBytes = value => createHash('sha256').update(value).digest('hex');
const packageName = name => /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name) && name !== '.' && name !== '..';

// Callers verify vendor entrypoint bytes first. Snapshot the full resolved
// dependency closure into private state: no executable dependency points back
// to a mutable installation. This freezes supplied bytes, not an audit of them.
async function snapshotCircleCliSource(source, originalEntrypoint) {
  const original = resolve(originalEntrypoint);
  const metadata = JSON.parse(await readFile(join(dirname(original),'..','package.json'),'utf8'));
  if (metadata.version !== approval.circleVersion || metadata.type !== 'module') throw new Error('Unexpected Circle runtime package metadata.');
  const packages = new Map(), packageRoots = new Map(); let byteCount = 0;
  async function dependenciesFor(pkg, entrypoint) {
    const links = [], lookup = createRequire(entrypoint);
    const required = pkg.dependencies ?? {};
    const names = {...required, ...pkg.optionalDependencies, ...pkg.peerDependencies};
    for (const name of Object.keys(names).sort()) {
      if (!packageName(name)) throw new Error('Unsafe Circle dependency name.');
      let packageRoot;
      for (const base of lookup.resolve.paths(name) ?? lookup.resolve.paths('__shadow_dependency_lookup__') ?? []) {
        const candidate = join(base,name); let identity;
        try { identity = JSON.parse(await readFile(join(candidate,'package.json'),'utf8')); } catch {}
        const spec = names[name];
        const expectedName = typeof spec === 'string' && spec.startsWith('npm:') ? spec.slice(4).replace(/@[^@/]*$/, '') : name;
        if (identity?.name === expectedName) { packageRoot = await realpath(candidate); break; }
      }
      if (!packageRoot) {
        if (isBuiltin(name)) continue;
        if (name in required && !(name in (pkg.optionalDependencies ?? {}))) throw new Error(`Circle dependency package identity unavailable: ${name}.`);
        continue;
      }
      const known = packageRoots.get(packageRoot);
      const id = known ?? `package-${String(packageRoots.size).padStart(6,'0')}`;
      links.push([name,id]);
      if (known !== undefined) continue;
      packageRoots.set(packageRoot,id);
      const identity = JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
      const record = {id, files:[], links:[]}; packages.set(id,record);
      async function walk(path, prefix = '') {
        for (const name of (await readdir(path)).sort()) {
          if (!prefix && name === 'node_modules') continue;
          const full = join(path,name), leaf = prefix ? `${prefix}/${name}` : name, info = await lstat(full);
          if (info.isDirectory()) await walk(full,leaf);
          else if (info.isFile()) {
            const bytes = await readFile(full); byteCount += bytes.length;
            if (byteCount > 512 * 1024 * 1024) throw new Error('Circle dependency snapshot exceeds its size limit.');
            record.files.push({path:leaf, bytes, hash:hashBytes(bytes)});
          } else throw new Error('Circle dependency contains unsupported links or special files.');
        }
      }
      await walk(packageRoot);
      record.links = await dependenciesFor(identity,join(packageRoot,'package.json'));
    }
    return links;
  }
  const topLinks = await dependenciesFor(metadata,original);
  const files = [{path:'dist/index.js',bytes:Buffer.from(source)}, {path:'package.json',bytes:Buffer.from(JSON.stringify(metadata))}];
  const links = topLinks.map(([name,id]) => ({path:`node_modules/${name}`, target:relative(dirname(`node_modules/${name}`),`packages/${id}`)}));
  for (const record of [...packages.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)) {
    for (const file of record.files) files.push({path:`packages/${record.id}/${file.path}`,bytes:file.bytes});
    for (const [name,id] of record.links) {
      const path = `packages/${record.id}/node_modules/${name}`;
      links.push({path,target:relative(dirname(path),`packages/${id}`)});
    }
  }
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0); links.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const manifest = JSON.stringify({files:files.map(f=>[f.path,hashBytes(f.bytes)]),links});
  const dependencyManifest = JSON.stringify({files:files.filter(f=>f.path!=='dist/index.js').map(f=>[f.path,hashBytes(f.bytes)]),links});
  return {files,links,manifest,dependencyManifest,dependencyDigest:hashBytes(dependencyManifest)};
}

// Read only inspection returns no executable cache. Approving this digest is
// a separate maintainer action; it must not be inferred from the live install.
export async function inspectCircleCliDependencies(originalEntrypoint) {
  const source = await readFile(resolve(originalEntrypoint),'utf8');
  const snapshot = await snapshotCircleCliSource(source,originalEntrypoint);
  return {dependencyDigest:snapshot.dependencyDigest,manifest:JSON.parse(snapshot.dependencyManifest)};
}

export async function freezeCircleCliSource(source, originalEntrypoint, runtimeDirectory, {approvedDependencyDigest = APPROVED_CIRCLE_DEPENDENCY_DIGEST} = {}) {
  if (!runtimeDirectory) throw new Error('An owner-controlled writable Circle runtime directory is required.');
  const snapshot = await snapshotCircleCliSource(source,originalEntrypoint);
  if (!/^[a-f0-9]{64}$/.test(approvedDependencyDigest ?? '') || snapshot.dependencyDigest !== approvedDependencyDigest) {
    throw new Error('Circle dependency closure differs from the approved manifest. Do not approve the live installation implicitly.');
  }
  const root = await requirePrivateState(runtimeDirectory);
  const {files,links,manifest} = snapshot;
  const directory = join(root,`verified-${hashBytes(manifest)}`);
  async function validate() {
    const expected = new Map(files.map(f=>[f.path,f]));
    const linkMap = new Map(links.map(l=>[l.path,l.target]));
    const dirs = new Set(['']);
    for (const path of [...expected.keys(),...linkMap.keys()]) {
      for(let parent=dirname(path);parent!=='.';parent=dirname(parent))dirs.add(parent);
    }
    async function walk(path,prefix='') {
      const info=await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode&0o777)!==0o700 || (process.getuid&&info.uid!==process.getuid())) throw new Error('Verified Circle cache permissions are unsafe.');
      for (const name of await readdir(path)) {
        const leaf=prefix?`${prefix}/${name}`:name, full=join(path,name), item=await lstat(full);
        if (process.getuid&&item.uid!==process.getuid()) throw new Error('Verified Circle cache ownership changed.');
        if (expected.has(leaf)) {
          if(!item.isFile()||item.isSymbolicLink()||(item.mode&0o777)!==0o400||!Buffer.from(await readFile(full)).equals(expected.get(leaf).bytes))throw new Error('Verified Circle cache source changed.');
          expected.delete(leaf);
        } else if (linkMap.has(leaf)) {
          if(!item.isSymbolicLink()||await readlink(full)!==linkMap.get(leaf))throw new Error('Verified Circle cache dependency changed.');
          linkMap.delete(leaf);
        } else if (dirs.has(leaf)) await walk(full,leaf);
        else throw new Error('Verified Circle cache contains an unexpected entry.');
      }
    }
    await walk(directory);
    if(expected.size||linkMap.size)throw new Error('Verified Circle cache is incomplete.');
    return join(directory,'dist','index.js');
  }
  try { await lstat(directory); return await validate(); } catch(error) { if(error.code!=='ENOENT')throw error; }
  const staging = await mkdtemp(join(root,'building-'));
  try {
    for (const file of files) { const target=join(staging,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,file.bytes,{mode:0o400,flag:'wx'}); }
    for (const link of links) { const target=join(staging,link.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await symlink(link.target,target,'dir'); }
    try{await rename(staging,directory);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
    return await validate();
  } finally { await rm(staging,{recursive:true,force:true}); }
}
