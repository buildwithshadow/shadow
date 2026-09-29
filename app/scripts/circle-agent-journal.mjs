import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

/** Local operator storage, outside the public repo. No automatic stale-lock theft. */
export async function createCircleAgentJournal(directory) {
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filename = key => join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  return {
    async get(key) {
      try { return JSON.parse(await readFile(filename(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async put(key, value) {
      const target = filename(key), temp = `${target}.${randomUUID()}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, target);
      const folder = await open(dir, 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    },
    async withLock(key, action) {
      const path = `${filename(key)}.lock`;
      let lock;
      try { lock = await open(path, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Circle wallet journal is locked. Resolve any active or interrupted operator before continuing.'); throw error; }
      try { await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync(); return await action(); }
      finally { await lock.close(); await unlink(path); }
    },
  };
}
