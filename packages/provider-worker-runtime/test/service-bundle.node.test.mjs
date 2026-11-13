import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const require = createRequire(import.meta.url);

// Unlike Vite's module loader, the normal Wrangler bundle must initialize
// without import.meta.url-dependent package discovery or any credential.
for (const [entry, coordinatorClass] of [['active-worker.ts', 'MainnetActiveProviderCoordinatorDO'], ['public-testnet-worker.ts', 'PublicTestnetProviderCoordinatorDO']]) test(`${entry} initializes as a normal Wrangler Worker bundle`, { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-service-bundle-'));
  const source = fileURLToPath(new URL(`../src/${entry}`, import.meta.url));
  const witness = fileURLToPath(new URL('../../provider-durable-store/src/do-witness.ts', import.meta.url));
  let child;
  try {
    writeFileSync(join(dir, 'entry.mjs'), `export {default, ${coordinatorClass}, RecordStoreDO, ProviderAdmin} from ${JSON.stringify(source)};\nexport {StoreWitnessDO} from ${JSON.stringify(witness)};\n`);
    writeFileSync(join(dir, 'wrangler.json'), JSON.stringify({ name: 'shadow-service-bundle-smoke', main: 'entry.mjs', compatibility_date: '2026-11-09', compatibility_flags: ['nodejs_compat'], workers_dev: false,
      durable_objects: { bindings: [
        { name: 'PROVIDER_COORDINATOR', class_name: coordinatorClass },
        { name: 'RECORD_STORE', class_name: 'RecordStoreDO' },
        { name: 'STORE_WITNESS', class_name: 'StoreWitnessDO' },
      ] }, migrations: [{ tag: 'v1', new_sqlite_classes: [coordinatorClass, 'RecordStoreDO', 'StoreWitnessDO'] }],
    }));
    const cli = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
    child = spawn(process.execPath, [cli, 'dev', '--local', '--ip', '127.0.0.1', '--port', '0', '--config', join(dir, 'wrangler.json')], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error(`Worker bundle did not initialize: ${output.slice(-3000)}`)), 20000);
      const consume = data => {
        output = (output + data.toString()).slice(-10000);
        const match = output.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`Worker bundle exited ${code}: ${output.slice(-3000)}`)); });
    });
    const response = await fetch(`${url}/accept`, { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.10', 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).reason, 'configuration-incomplete');
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGINT');
      let timer;
      try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000); })]); }
      finally { clearTimeout(timer); }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
