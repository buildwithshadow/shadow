import { mkdir, lstat, realpath, open } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { constants } from 'node:fs';

// A dedicated worker keeps a kernel cwd reference to the verified directory.
// Every file operation is relative to that cwd. No later parent-path lookup can
// redirect a read, atomic rename or lock to another journal. Node's fs API does
// not expose openat/renameat, so do not emulate them with pathname rechecks.
const WORKER = `
import {open,stat,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createInterface} from 'node:readline';
const [dev,ino]=process.argv.slice(1);
async function check(){
  const d=await stat('.');
  if(!d.isDirectory()||String(d.dev)!==dev||String(d.ino)!==ino||(d.mode&0o077)!==0||(process.getuid&&d.uid!==process.getuid()))throw Error('Circle journal directory identity or private permissions changed.');
}
await check();
const folder=await open('.',constants.O_RDONLY|constants.O_DIRECTORY);
for await(const line of createInterface({input:process.stdin})){
  let r;
  try{
    r=JSON.parse(line);if(!/^[a-f0-9]{64}\\.json(?:\\.lock)?$/.test(r.name))throw Error('Invalid journal filename.');
    await check();const path='./'+r.name;let value=null;
    if(r.op==='get'){
      let file;
      try{
        file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const m=await file.stat();
        if(!m.isFile()||(m.mode&0o077)!==0||(process.getuid&&m.uid!==process.getuid())||m.size>2000000)throw Error('Circle journal record permissions or size are unsafe.');
        value=JSON.parse(await file.readFile('utf8'));
      }catch(e){if(e.code!=='ENOENT')throw e;}finally{if(file)await file.close();}
    }else if(r.op==='put'){
      const temp=path+'.'+r.id+'.tmp';const f=await open(temp,'wx',0o600);
      try{await f.writeFile(JSON.stringify(r.value)+'\\n');await f.sync();}finally{await f.close();}
      await rename(temp,path);await folder.sync();
    }else if(r.op==='lock'){
      const f=await open(path,'wx',0o600);
      try{await f.writeFile(JSON.stringify(r.value));await f.sync();}finally{await f.close();}
      await folder.sync();
    }else if(r.op==='unlock'){
      const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const saved=JSON.parse(await f.readFile('utf8'));if(saved.token!==r.value.token)throw Error('Circle lock identity changed.');}finally{await f.close();}
      await unlink(path);await folder.sync();
    }else throw Error('Unsupported journal operation.');
    process.stdout.write(JSON.stringify({id:r.id,value})+'\\n');
  }catch(e){process.stdout.write(JSON.stringify({id:r?.id,error:e.message,code:e.code})+'\\n');}
}
await folder.close();
`;

/** Single-host operator storage. Process death never authorizes lock theft. */
export async function createCircleAgentJournal(directory) {
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (await realpath(dir) !== dir || !info.isDirectory() || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Circle journal must be an owner-controlled private directory without symlinked path components.');
  }
  // Persist identity outside the replaceable root. A second adapter must not
  // silently initialize an empty directory at the same configured pathname.
  const parent = dirname(dir), parentInfo = await lstat(parent);
  if ((parentInfo.mode & 0o022) !== 0 || (process.getuid && parentInfo.uid !== process.getuid())) {
    throw new Error('Circle journal parent must be owner-controlled and not writable by other users.');
  }
  const anchor = join(parent, `.circle-journal-${createHash('sha256').update(dir).digest('hex')}.identity`);
  const identity = { path: dir, dev: String(info.dev), ino: String(info.ino) };
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
  const worker = spawn(process.execPath, ['--input-type=module', '-e', WORKER, String(info.dev), String(info.ino)], {
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
    runtimeDirectory: join(dir, 'verified-circle-runtime'),
    get: key => call('get', filename(key)),
    put: (key, value) => call('put', filename(key), value),
    async withLock(key, action) {
      const name = filename(key) + '.lock', token = randomUUID();
      try { await call('lock', name, { token, pid: process.pid, createdAt: new Date().toISOString() }); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Circle wallet journal is locked. Resolve any active or interrupted operator before continuing.'); throw error; }
      try { return await action(); } finally { await call('unlock', name, { token }); }
    },
    close() { stopped = true; worker.stdin.end(); },
  };
}
