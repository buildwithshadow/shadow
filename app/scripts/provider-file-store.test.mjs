import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileProviderStore } from '../../examples/float-mainnet-provider-server/file-store.mjs';
import { stableStringify } from './float-mainnet-preflight.mjs';

const digest = `0x${'ab'.repeat(32)}`;
function fixture(t, witnessed = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shadow-file-store-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { directory: join(root, 'records'), witnessDirectory: witnessed ? join(root, 'witness') : null,
    identity: { provider: 'provider', chainId: '5042', contract: 'contract', endpointHash: 'endpoint' } };
  return { options, make: (extra = {}) => createFileProviderStore({ ...options, ...extra }) };
}
test('stored result bytes and original request binding survive restart without overwrite', t => {
  const { options, make } = fixture(t);
  const store = make();
  const result = { digest, requestId: 'first', result: Buffer.from('original report\n').toString('base64') };
  const name = `${digest}.result.json`, claim = `request-${digest}.json`;
  assert.equal(store.putOnce(name, result), true);
  assert.equal(store.putOnce(claim, { requestId: 'first', digest }), true);
  const bytes = readFileSync(join(options.directory, name));
  assert.equal(bytes.toString(), `${stableStringify(result)}\n`);
  const recovered = make({ recoveryOnly: true });
  assert.deepEqual(recovered.read(name), result);
  assert.deepEqual(recovered.read(claim), { requestId: 'first', digest });
  assert.equal(recovered.putOnce(name, { result: 'replacement' }), false);
  assert.deepEqual(readFileSync(join(options.directory, name)), bytes);
  assert.equal(recovered.has(name), true);
  assert.deepEqual(recovered.list().sort(), [name, claim].sort());
  recovered.assertConsistent();
});
test('a changed or missing provider record remains held after restart', t => {
  const { options, make } = fixture(t);
  const store = make(), name = `${digest}.delivery.json`;
  store.putOnce(name, { original: true });
  writeFileSync(join(options.directory, name), '{"changed":true}\n');
  assert.throws(() => store.assertConsistent(), /differs from durable witness/);
  assert.throws(() => make(), /differs from durable witness/);
  unlinkSync(join(options.directory, name));
  assert.throws(() => make(), /missing or unsafe record/);
});
test('missing witness cannot be recreated for a populated store', t => {
  const { options, make } = fixture(t, false);
  make().putOnce(`${digest}.acceptance.json`, { digest });
  assert.throws(() => make({ witnessDirectory: join(options.directory, '..', 'witness') }), /verified migration/);
});
test('recovery does not create a missing directory or witness', t => {
  const { make } = fixture(t);
  assert.throws(() => make({ recoveryOnly: true }), /ENOENT/);
  make({ witnessDirectory: null });
  assert.throws(() => make({ recoveryOnly: true }), /existing witness/);
});
test('record names cannot escape the store and missing reads remain null', t => {
  const { make } = fixture(t, false), store = make();
  assert.equal(store.witnessed, false);
  assert.equal(store.read(`${digest}.result.json`), null);
  for (const name of ['../outside.json', '/outside.json', '0xnot-a-digest.result.json']) {
    assert.throws(() => store.putOnce(name, {}), /Invalid provider record name/);
    assert.throws(() => store.read(name), /Invalid provider record name/);
  }
});
