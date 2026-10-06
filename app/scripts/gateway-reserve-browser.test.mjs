import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { makeGatewayIntent, runGatewayStep } from './gateway-reserve.mjs';
import { createGatewayBrowserJournal } from './gateway-reserve-browser-journal.mjs';

const account = '0x1111111111111111111111111111111111111111';
const intent = () => makeGatewayIntent({ account, sponsor: account, amount: '100000', maxFee: '10000', maxBlockHeight: '123456' });
function environment() {
  const data = new Map(), held = new Set();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const locks = { async request(key, options, work) {
    assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
    if (held.has(key)) return work(null);
    held.add(key);
    try { return await work({ name: key }); } finally { held.delete(key); }
  } };
  const create = () => createGatewayBrowserJournal({ account, storage, locks });
  return { data, storage, locks, create };
}
for (const phase of ['approve-deposit', 'deposit', 'attestation', 'mint', 'approve-reserve', 'open']) {
  test(`browser ${phase}: effect succeeds but response is lost; reload never sends twice`, async () => {
    const env = environment(), journal = env.create(), operation = (await journal.begin(intent())).operation;
    let sends = 0;
    const options = { sponsor: account, journal, operation, phase, request: { original: 'fixed' }, send: async () => { sends++; throw Error('timeout after effect'); }, reconcile: async () => null };
    await assert.rejects(runGatewayStep(options), /timeout/);
    assert.equal((await runGatewayStep({ ...options, journal: env.create() })).status, 'unknown');
    const done = await runGatewayStep({ ...options, journal: env.create(), reconcile: async () => ({ exactOriginalReceipt: 'verified' }) });
    assert.equal(done.status, 'confirmed');
    assert.equal((await runGatewayStep({ ...options, journal: env.create() })).status, 'confirmed');
    assert.equal(sends, 1);
    await assert.rejects(runGatewayStep({ ...options, request: { original: 'changed' } }), /changed request/);
    await assert.rejects(env.create().begin(intent()), /existing Gateway/);
  });
}
test('two tabs cannot both execute, even with different phase names', async () => {
  const env = environment(), first = env.create(), second = env.create();
  const operation = (await first.begin(intent())).operation;
  let release, entered;
  const gate = new Promise(r => release = r), start = new Promise(r => entered = r);
  let sends = 0;
  const options = { sponsor: account, journal: first, operation, phase: 'deposit', request: {}, send: async () => { sends++; entered(); await gate; return {}; }, reconcile: async () => null };
  const pending = runGatewayStep(options);
  await start;
  await assert.rejects(runGatewayStep({ ...options, journal: second, phase: 'mint' }), /another tab/);
  release(); await pending;
  assert.equal(sends, 1);
});
test('storage failure before effect cannot send; failed response persistence remains held', async () => {
  const env = environment(), journal = env.create(), operation = (await journal.begin(intent())).operation;
  let sends = 0;
  const original = env.storage.setItem;
  env.storage.setItem = () => { throw Error('quota'); };
  const options = { sponsor: account, journal, operation, phase: 'attestation', request: {}, send: async () => { sends++; return { id: 'transfer-1' }; }, reconcile: async () => null };
  await assert.rejects(runGatewayStep(options), /quota/);
  assert.equal(sends, 0);
  env.storage.setItem = original;
  await assert.rejects(runGatewayStep({ ...options, send: async () => { sends++; env.storage.setItem = () => { throw Error('quota'); }; return { id: 'transfer-1' }; } }), /quota/);
  env.storage.setItem = original;
  assert.equal((await runGatewayStep({ ...options, journal: env.create() })).status, 'unknown');
  assert.equal(sends, 1);
});
test('missing locks, corrupt records, mismatched sponsor and silent storage failure stop funding', async () => {
  const env = environment();
  assert.throws(() => createGatewayBrowserJournal({ account, storage: env.storage, locks: {} }), /coordinate/);
  const j = env.create(); await j.begin(intent());
  env.data.set(j.key, '{broken');
  assert.throws(() => env.create().load(), /invalid/);
  env.data.clear();
  const i = intent(); i.spec.destinationRecipient = '0x' + '22'.repeat(32);
  await assert.rejects(j.begin(i), /bounded sponsor/);
  env.storage.setItem = () => {};
  await assert.rejects(j.begin(intent()), /retain/);
});
test('journal prevents changed stored response and confirmed outcome', async () => {
  const env = environment(), j = env.create(), operation = (await j.begin(intent())).operation;
  const options = { sponsor: account, journal: j, operation, phase: 'mint', request: {}, send: async () => ({ hash: 'original' }), reconcile: async () => ({ hash: 'original' }) };
  const done = await runGatewayStep(options), key = `gateway:${operation}:mint`;
  await assert.rejects(j.put(key, done), /tab lock/);
  await assert.rejects(j.withLock('', () => j.put(key, { ...done, response: { hash: 'other' } })), /response cannot change/);
  await assert.rejects(j.withLock('', () => j.put(key, { ...done, status: 'unknown' })), /outcome cannot change/);
  await assert.rejects(j.get(`gateway:wrong:mint`), /does not match/);
});
test('browser bundle has no Node built-ins or Buffer dependency', async () => {
  const warnings = [];
  const output = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
    lib: { entry: new URL('./gateway-reserve-browser-journal.mjs', import.meta.url).pathname, formats: ['es'] },
    rollupOptions: { onwarn: warning => warnings.push(warning.message) } } });
  const code = (Array.isArray(output) ? output : [output]).flatMap(x => x.output).filter(x => x.type === 'chunk').map(x => x.code).join('\n');
  assert(!warnings.some(x => /externalized|node:/.test(x)), warnings.join('\n'));
  assert(!/\bBuffer\b|node:assert|node:crypto|__vite-browser-external/.test(code));
});
