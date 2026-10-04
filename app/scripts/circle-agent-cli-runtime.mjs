import { realpath, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Callers must verify vendor bytes before using this helper. Compatibility
// transformations must be derived only from the reviewed, hash-pinned source.
// Copies stay inside an owner-only directory, independent of subsequent changes
// to the source path or process cwd. Dependencies remain in the isolated install.
export async function freezeCircleCliSource(source, originalEntrypoint) {
  const parent = await realpath(dirname(resolve(originalEntrypoint)));
  const directory = await mkdtemp(join(parent, '.shadow-verified-'));
  await mkdir(join(directory, 'dist'), { mode: 0o700 });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', version: '1.1.4' }), { mode: 0o400, flag: 'wx' });
  const entrypoint = join(directory, 'dist', 'index.js');
  await writeFile(entrypoint, source, { mode: 0o400, flag: 'wx' });
  return entrypoint;
}
