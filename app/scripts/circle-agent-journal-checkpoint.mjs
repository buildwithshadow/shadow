import { open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const hash = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');

export async function privateBytes(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || info.size > 2_000_000) {
      throw Error('Circle journal record permissions or size are unsafe.');
    }
    return await file.readFile();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await file?.close(); }
}

// The checkpoint lives outside the replaceable journal. Write it BEFORE the
// record: a crash between the writes must create a mismatch, never permission
// to replay an operation. This protects journal-only restores, not loss or
// rollback of the independent trusted checkpoint store itself.
export async function checkpointRecord(directory, name, action) {
  const checkpoint = join(directory, `${name}.checkpoint`);
  const lock = `${checkpoint}.lock`;
  let held;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { held = await open(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 19) throw Error('Circle journal checkpoint is locked. Reconcile the interrupted writer; do not reset state or resend.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    const before = await privateBytes(`./${name}`);
    const saved = await privateBytes(checkpoint);
    const expected = saved === null ? null : JSON.parse(saved.toString());
    if (saved !== null && (!expected || expected.version !== 1 || Object.keys(expected).sort().join(',') !== 'hash,version' ||
        expected.hash !== null && (typeof expected.hash !== 'string' || !/^[a-f0-9]{64}$/.test(expected.hash)))) throw Error('Invalid Circle journal checkpoint.');
    if (hash(before) !== (expected?.hash ?? null)) {
      throw Error('Circle journal rollback or unregistered record detected. Reconcile against the original operation; do not resend.');
    }
    const commit = async bytes => {
      const temp = `${checkpoint}.${randomUUID()}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, hash: hash(bytes) })); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, checkpoint);
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
    };
    return await action(before, commit);
  } finally {
    await held.close();
    await unlink(lock);
  }
}
