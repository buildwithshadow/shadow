import { mkdir, lstat, realpath, open, readdir, link, unlink } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { requirePrivateState } from './circle-agent-private-state.mjs';
import { constants } from 'node:fs';
import { privateBytes } from './circle-agent-journal-checkpoint.mjs';

// A dedicated worker keeps a kernel cwd reference to the verified directory.
// Every file operation is relative to that cwd. No later parent-path lookup can
// redirect a read, atomic rename or lock to another journal. Node's fs API does
// not expose openat/renameat, so do not emulate them with pathname rechecks.
const WORKER = `
import {open,stat,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createInterface} from 'node:readline';
import {checkpointRecord,privateBytes} from ${JSON.stringify(new URL('./circle-agent-journal-checkpoint.mjs', import.meta.url).href)};
const [dev,ino,checkpointDirectory,rootToken]=process.argv.slice(1);
async function check(){
  const d=await stat('.');
  if(!d.isDirectory()||String(d.dev)!==dev||String(d.ino)!==ino||(d.mode&0o077)!==0||(process.getuid&&d.uid!==process.getuid()))throw Error('Circle journal directory identity or private permissions changed.');
  if((await privateBytes('./.root-token'))?.toString()!==rootToken)throw Error('Circle journal root token changed.');
}
await check();
const folder=await open('.',constants.O_RDONLY|constants.O_DIRECTORY);
for await(const line of createInterface({input:process.stdin})){
  let r;
  try{
    r=JSON.parse(line);if(!/^[a-f0-9]{64}\\.json(?:\\.lock)?$/.test(r.name))throw Error('Invalid journal filename.');
    await check();const path='./'+r.name;let value=null;
    value=await checkpointRecord(checkpointDirectory,r.name,async(before,commit)=>{
      if(r.op==='get')return before===null?null:JSON.parse(before.toString());
      if(r.op==='put'){
        const bytes=Buffer.from(JSON.stringify(r.value)+'\\n');
        await commit(bytes);
        const temp=path+'.'+r.id+'.tmp';const f=await open(temp,'wx',0o600);
        try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
        await rename(temp,path);await folder.sync();
      }else if(r.op==='lock'){
        if(before!==null)throw Object.assign(Error('Journal lock exists.'),{code:'EEXIST'});
        const bytes=Buffer.from(JSON.stringify(r.value));await commit(bytes);
        const f=await open(path,'wx',0o600);
        try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
        await folder.sync();
      }else if(r.op==='unlock'){
        if(before===null||JSON.parse(before.toString()).token!==r.value.token)throw Error('Circle lock identity changed.');
        await commit(null);await unlink(path);await folder.sync();
      }else throw Error('Unsupported journal operation.');
      return null;
    });
    process.stdout.write(JSON.stringify({id:r.id,value})+'\\n');
  }catch(e){process.stdout.write(JSON.stringify({id:r?.id,error:e.message,code:e.code})+'\\n');}
}
await folder.close();
`;

/** Single-host operator storage. Process death never authorizes lock theft. */
export async function createCircleAgentJournal(directory, { identityDirectory = join(homedir(), ".local", "state", "shadow", "journal-identities") } = {}) {
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (await realpath(dir) !== dir || !info.isDirectory() || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Circle journal must be an owner-controlled private directory without symlinked path components.');
  }
  // Persist identity outside the replaceable root. A second adapter must not
  // silently initialize an empty directory at the same configured pathname.
  const identityPath = resolve(identityDirectory);
  if (identityPath === dir || identityPath.startsWith(dir + sep)) {
    throw new Error('Circle identity and checkpoint storage must be outside the journal root.');
  }
  const parent = await requirePrivateState(identityPath);
  const anchor = join(parent, `${createHash('sha256').update(dir).digest('hex')}.identity`);
  const tokenPath = join(dir, '.root-token');
  let tokenBytes = await privateBytes(tokenPath);
  if (tokenBytes === null) {
    if (await privateBytes(anchor) !== null || (await readdir(dir)).length !== 0) {
      throw new Error('Circle journal root was replaced or needs explicit legacy reconciliation; do not initialize missing identity state.');
    }
    const token = randomBytes(32).toString('hex');
    const file = await open(tokenPath, 'wx', 0o600);
    try { await file.writeFile(token); await file.sync(); } finally { await file.close(); }
    const folder = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await folder.sync(); } finally { await folder.close(); }
    tokenBytes = Buffer.from(token);
  }
  const token = tokenBytes.toString();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Circle journal root token is invalid.');
  // A copied root must never silently become an independent writable journal.
  if (await privateBytes(anchor) === null && (await readdir(dir)).some(name => name !== '.root-token')) {
    throw new Error('Restored Circle journal requires explicit reconciliation before registration.');
  }
  const identity = { path: dir, dev: String(info.dev), ino: String(info.ino), token };
  let marker;
  try {
    marker = await open(anchor, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await marker.writeFile(JSON.stringify(identity)); await marker.sync();
    const folder = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await folder.sync(); } finally { await folder.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const saved = await open(anchor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await saved.stat();
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 4096
          || (process.getuid && metadata.uid !== process.getuid())) throw new Error('Circle journal identity marker is unsafe.');
      const previous = JSON.parse(await saved.readFile('utf8'));
      if (JSON.stringify(previous) !== JSON.stringify(identity)) throw new Error('Circle journal root was replaced. Restore the original root or explicitly reconcile its full records and locks; do not reset its identity marker.');
    } finally { await saved.close(); }
  } finally { if (marker) await marker.close(); }
  // Bind a wallet namespace to one root across every journal using this
  // operator identity store. A fresh root must not create a fresh spend ledger.
  const bindings = await requirePrivateState(join(parent, 'wallet-root-bindings'));
  // Persist the new binding directory entry before any operation can rely on it.
  const bindingParent = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await bindingParent.sync(); } finally { await bindingParent.close(); }
  async function bindNamespace(key) {
    if (typeof key !== 'string' || !key.length || key.length > 256) throw new Error('Invalid Circle wallet namespace.');
    await requirePrivateState(bindings);
    const path = join(bindings, createHash('sha256').update(key).digest('hex') + '.json');
    const expected = Buffer.from(JSON.stringify({version: 1, namespace: key, journal: identity}));
    // Publish only complete, synced bytes. An exclusive hard link selects one
    // winner without exposing a partially written canonical binding.
    const temporary = path + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(expected); await file.sync();
      try { await link(temporary, path); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await privateBytes(path);
        if (!previous?.equals(expected)) throw new Error('Circle wallet namespace belongs to another journal root or has invalid binding state. Reconcile the original journal; do not switch roots or resend.');
      }
      // Also sync when another writer won: its publication must be durable
      // before this caller can enter the wallet operation.
      const folder = await open(bindings, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await folder.sync(); } finally { await folder.close(); }
    } finally { await file.close(); await unlink(temporary); }
  }
  const checkpointDirectory = await requirePrivateState(`${anchor}.records`);
  const worker = spawn(process.execPath, ['--input-type=module', '-e', WORKER, String(info.dev), String(info.ino), checkpointDirectory, token], {
    cwd: dir, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const requests = new Map();
  let stopped = false;
  function fail() {
    stopped = true;
    for (const pending of requests.values()) pending.reject(new Error('Circle journal worker stopped. Preserve the original request and lock; do not resend.'));
    requests.clear();
  }
  worker.on('error', fail); worker.on('exit', fail);
  createInterface({ input: worker.stdout }).on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { fail(); worker.kill(); return; }
    const pending = requests.get(response.id);
    if (!pending) return;
    requests.delete(response.id);
    if (response.error) {
      const error = new Error(response.error); error.code = response.code; pending.reject(error);
    } else pending.resolve(response.value);
    if (!requests.size) { worker.unref(); worker.stdin.unref(); worker.stdout.unref(); }
  });
  worker.unref(); worker.stdin.unref(); worker.stdout.unref();
  const filename = key => `${createHash('sha256').update(key).digest('hex')}.json`;
  function call(op, name, value) {
    if (stopped) return Promise.reject(new Error('Circle journal is closed. Preserve the original request; do not resend.'));
    const id = randomUUID();
    worker.ref(); worker.stdin.ref(); worker.stdout.ref();
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      worker.stdin.write(JSON.stringify({ id, op, name, value }) + '\n', error => { if (error) fail(); });
    });
  }
  // A probe waits for the child to verify its actual cwd before returning.
  await call('get', filename('journal-directory-probe'));
  return {
    runtimeDirectory: join(parent, 'verified-circle-runtime'),
    get: key => call('get', filename(key)),
    put: (key, value) => call('put', filename(key), value),
    async withLock(key, action) {
      await bindNamespace(key);
      const name = filename(key) + '.lock', token = randomUUID();
      try { await call('lock', name, { token, pid: process.pid, createdAt: new Date().toISOString() }); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Circle wallet journal is locked. Resolve any active or interrupted operator before continuing.'); throw error; }
      try { return await action(); } finally { await call('unlock', name, { token }); }
    },
    close() { stopped = true; worker.stdin.end(); },
  };
}
