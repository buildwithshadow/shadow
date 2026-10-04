import { mkdir, open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

/** Local operator storage, outside the public repo. No automatic stale-lock theft. */
export async function createCircleAgentJournal(directory) {
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(dir);
  const originalDevice = directoryStat.dev, originalInode = directoryStat.ino;
  async function checkDirectory() {
    // Canonicalize the entire path, not only its leaf: an intermediate alias
    // must never switch an active adapter to a journal without its barrier.
    const current = await lstat(dir);
    if (await realpath(dir) !== dir || current.dev !== originalDevice || current.ino !== originalInode
        || !current.isDirectory() || (current.mode & 0o077) !== 0
        || (process.getuid && current.uid !== process.getuid())) {
      throw new Error('Circle journal must remain the same owner-controlled private directory without symlinked path components.');
    }
  }
  await checkDirectory();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || (directoryStat.mode & 0o077) !== 0
      || (process.getuid && directoryStat.uid !== process.getuid())) {
    throw new Error('Circle journal must be an owner-controlled private directory; inspect restored permissions before continuing.');
  }
  const filename = key => join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  return {
    async get(key) {
      await checkDirectory();
      let file;
      try {
        file = await open(filename(key), constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await file.stat();
        if (!metadata.isFile() || (metadata.mode & 0o077) !== 0
            || (process.getuid && metadata.uid !== process.getuid())) {
          throw new Error('Circle journal record permissions are unsafe; do not restore or resend from this record.');
        }
        return JSON.parse(await file.readFile('utf8'));
      }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      finally { if (file) await file.close(); }
    },
    async put(key, value) {
      await checkDirectory();
      const target = filename(key), temp = `${target}.${randomUUID()}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, target);
      const folder = await open(dir, 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    },
    async withLock(key, action) {
      await checkDirectory();
      const path = `${filename(key)}.lock`;
      let lock;
      try { lock = await open(path, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Circle wallet journal is locked. Resolve any active or interrupted operator before continuing.'); throw error; }
      try { await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync(); return await action(); }
      finally { await lock.close(); await unlink(path); }
    },
  };
}
