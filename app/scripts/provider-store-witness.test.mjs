import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { captureStoreSnapshot, initializeStoreWitness, createStoreWitness, ProviderStoreHold } from '../../examples/float-mainnet-provider-server/store-witness.mjs';
import { storeOnce } from './float-mainnet-provider.mjs';
import { stableStringify } from './float-mainnet-preflight.mjs';
const digest = `0x${'ab'.repeat(32)}`;
const serialize = value => `${stableStringify(value)}\n`;
function fixture(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provider-witness-')));
  const storeDir = join(root, 'store'), witnessDir = join(root, 'witness');
  mkdirSync(storeDir);
  const options = { storeDir, witnessDir, identity: { provider: 'provider', chainId: '5042', contract: 'contract' }, storeOnce, serialize };
  try { return fn({ root, storeDir, witnessDir, options, make: () => createStoreWitness(options) }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('witness keeps nested records byte exact across restart and deduplicates', () => fixture(({ storeDir, make }) => {
  const file = join(storeDir, `${digest}.acceptance.json`), value = { nested: { b: 2, a: 1 }, digest };
  assert.equal(make().storeOnce(file, value), true);
  const restarted = make();
  assert.equal(restarted.storeOnce(file, { changed: true }), false);
  assert.equal(readFileSync(file, 'utf8'), serialize(value));
  restarted.assertConsistent();
}));

test('restoring a pre delivery backup holds rather than creating another receipt or work marker', () => fixture(({ root, storeDir, make }) => {
  const witness = make(), acceptance = join(storeDir, `${digest}.acceptance.json`);
  witness.storeOnce(acceptance, { digest, requestId: 'job' });
  cpSync(storeDir, join(root, 'backup'), { recursive: true });
  for (const slot of ['started', 'result', 'delivery']) witness.storeOnce(join(storeDir, `${digest}.${slot}.json`), { digest, slot });
  for (const name of readdirSync(storeDir)) unlinkSync(join(storeDir, name));
  cpSync(join(root, 'backup'), storeDir, { recursive: true });
  assert.throws(() => witness.assertConsistent(), ProviderStoreHold);
  assert.throws(make, ProviderStoreHold);
  assert.throws(() => witness.storeOnce(join(storeDir, `${digest}.started.json`), { repeated: true }), ProviderStoreHold);
  assert.equal(existsSync(join(storeDir, `${digest}.started.json`)), false);
}));

test('missing acceptance and request binding after a restore are held', () => fixture(({ storeDir, make }) => {
  const witness = make(), file = join(storeDir, `${digest}.acceptance.json`);
  witness.storeOnce(file, { digest }); unlinkSync(file);
  assert.throws(() => witness.assertConsistent(), /missing or unsafe record/);
}));

test('changed result bytes and untracked imported records fail closed', () => fixture(({ storeDir, make }) => {
  const witness = make(), file = join(storeDir, `${digest}.result.json`);
  witness.storeOnce(file, { result: 'original' }); writeFileSync(file, serialize({ result: 'changed' }));
  assert.throws(() => witness.assertConsistent(), /differs from durable witness/);
}));

test('crash after durable witness publication before the provider write holds', () => fixture(({ options, storeDir, witnessDir }) => {
  let interrupt = false;
  const failStore = (file, value) => {
    if (interrupt && file.startsWith(`${storeDir}/`)) throw new Error('simulated crash');
    return storeOnce(file, value);
  };
  const witness = createStoreWitness({ ...options, storeOnce: failStore });
  interrupt = true;
  const file = join(storeDir, `${digest}.result.json`);
  assert.throws(() => witness.storeOnce(file, { result: 'original' }), /simulated crash/);
  assert.equal(existsSync(join(witnessDir, `${digest}.result.json`)), true);
  assert.equal(existsSync(file), false);
  assert.throws(() => createStoreWitness(options), ProviderStoreHold);
}));

test('missing witness cannot initialize on an existing store', () => fixture(({ storeDir, make }) => {
  writeFileSync(join(storeDir, `${digest}.acceptance.json`), serialize({ digest }));
  assert.throws(make, /verified migration/);
}));

test('witness identity cannot switch provider deployment', () => fixture(({ options, make }) => {
  make();
  assert.throws(() => createStoreWitness({ ...options, identity: { ...options.identity, contract: 'another' } }), /identity/);
}));

test('nested witness and symlink records are refused', () => fixture(({ options, storeDir, root, make }) => {
  assert.throws(() => createStoreWitness({ ...options, witnessDir: join(storeDir, 'nested') }), ProviderStoreHold);
  const witness = make(), file = join(storeDir, `${digest}.result.json`);
  witness.storeOnce(file, { digest });
  cpSync(file, join(root, 'replacement.json')); unlinkSync(file); symlinkSync(join(root, 'replacement.json'), file);
  assert.throws(() => witness.assertConsistent(), /unsafe record/);
}));

test('unknown imported records cannot silently become authoritative', () => fixture(({ storeDir, make }) => {
  const witness = make();
  writeFileSync(join(storeDir, `${digest}.acceptance.json`), serialize({ digest }));
  assert.throws(() => witness.assertConsistent(), /unwitnessed/);
}));

 test('recovery mode never initializes missing witness state', () => fixture(({ options, witnessDir }) => {
  assert.throws(() => createStoreWitness({ ...options, readOnly: true }), /existing witness/);
  assert.equal(existsSync(witnessDir), false);
}));

const fingerprint = snapshot => createHash('sha256').update(serialize(snapshot)).digest('hex');

test('explicit approved inventory initializes existing records without changing their bytes', () => fixture(({ options, storeDir, make }) => {
  const file = join(storeDir, `${digest}.acceptance.json`);
  storeOnce(file, { digest, requestId: 'original' });
  const before = readFileSync(file);
  const snapshot = captureStoreSnapshot(options);
  assert.deepEqual(initializeStoreWitness({ ...options, snapshot, approvedSnapshotSha256: fingerprint(snapshot) }),
    { initialized: true, records: 1, approvedSnapshotSha256: fingerprint(snapshot) });
  assert.deepEqual(readFileSync(file), before);
  make().assertConsistent();
  assert.throws(() => initializeStoreWitness({ ...options, snapshot, approvedSnapshotSha256: fingerprint(snapshot) }), /EEXIST/);
}));

test('changed or extra records and missing approval refuse migration before writing', () => fixture(({ options, storeDir, witnessDir }) => {
  const file = join(storeDir, `${digest}.acceptance.json`); storeOnce(file, { digest });
  const snapshot = captureStoreSnapshot(options), approvedSnapshotSha256 = fingerprint(snapshot);
  assert.throws(() => initializeStoreWitness({ ...options, snapshot }), /approved fingerprint/);
  writeFileSync(file, serialize({ changed: true }));
  assert.throws(() => initializeStoreWitness({ ...options, snapshot, approvedSnapshotSha256 }), /no longer matches/);
  assert.equal(existsSync(witnessDir), false);
}));

test('migration rejects another deployment, path and witness inside the store', () => fixture(({ options, storeDir, witnessDir }) => {
  storeOnce(join(storeDir, `${digest}.acceptance.json`), { digest });
  const snapshot = captureStoreSnapshot(options), approvedSnapshotSha256 = fingerprint(snapshot);
  assert.throws(() => initializeStoreWitness({ ...options, identity: { ...options.identity, contract: 'wrong' }, snapshot, approvedSnapshotSha256 }), /no longer matches/);
  assert.throws(() => initializeStoreWitness({ ...options, snapshot, approvedSnapshotSha256, witnessDir: join(storeDir, 'witness') }), /location/);
  assert.equal(existsSync(witnessDir), false);
}));

test('interrupted migration remains incomplete and cannot resume automatically', () => fixture(({ options, storeDir, witnessDir, make }) => {
  storeOnce(join(storeDir, `${digest}.acceptance.json`), { digest });
  const snapshot = captureStoreSnapshot(options), approvedSnapshotSha256 = fingerprint(snapshot);
  const failStore = (file, value) => { if (file.endsWith('/identity.json')) throw new Error('interrupted commit'); return storeOnce(file, value); };
  assert.throws(() => initializeStoreWitness({ ...options, storeOnce: failStore, snapshot, approvedSnapshotSha256 }), /interrupted commit/);
  assert.equal(existsSync(join(witnessDir, `${digest}.acceptance.json`)), true);
  assert.equal(existsSync(join(witnessDir, 'identity.json')), false);
  assert.throws(make, /missing identity/);
  assert.throws(() => initializeStoreWitness({ ...options, snapshot, approvedSnapshotSha256 }), /EEXIST/);
}));

test('store activity during migration prevents publishing the identity commit marker', () => fixture(({ options, storeDir, witnessDir, make }) => {
  const file = join(storeDir, `${digest}.acceptance.json`); storeOnce(file, { digest });
  const snapshot = captureStoreSnapshot(options), approvedSnapshotSha256 = fingerprint(snapshot);
  const changingStore = (target, value) => {
    const result = storeOnce(target, value);
    writeFileSync(file, serialize({ changedDuringInitialization: true }));
    return result;
  };
  assert.throws(() => initializeStoreWitness({ ...options, storeOnce: changingStore, snapshot, approvedSnapshotSha256 }), /no longer matches/);
  assert.equal(existsSync(join(witnessDir, 'identity.json')), false);
  assert.throws(make, /missing identity/);
}));


test('unsupported Windows migration refuses before creating any witness directory', () => fixture(({ options, storeDir, witnessDir }) => {
  storeOnce(join(storeDir, `${digest}.acceptance.json`), { digest });
  const snapshot = captureStoreSnapshot(options), approvedSnapshotSha256 = fingerprint(snapshot);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.throws(() => initializeStoreWitness({ ...options, snapshot, approvedSnapshotSha256 }), /directory durability/);
    assert.equal(existsSync(witnessDir), false);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
}));


test('symlinked witness ancestors refuse before creating an incomplete directory', () => fixture(({ options, root, storeDir }) => {
  storeOnce(join(storeDir, `${digest}.acceptance.json`), { digest });
  const snapshot = captureStoreSnapshot(options), approvedSnapshotSha256 = fingerprint(snapshot);
  const parent = join(root, 'real-parent'), alias = join(root, 'parent-alias');
  mkdirSync(parent); symlinkSync(parent, alias);
  const target = join(parent, 'witness');
  assert.throws(() => initializeStoreWitness({ ...options, witnessDir: join(alias, 'witness'), snapshot, approvedSnapshotSha256 }), /witness parent/);
  assert.equal(existsSync(target), false);
}));

test('fresh server witness refuses symlinked ancestors without writing there', () => fixture(({ options, root }) => {
  const parent = join(root, 'real-parent'), alias = join(root, 'parent-alias');
  mkdirSync(parent); symlinkSync(parent, alias);
  assert.throws(() => createStoreWitness({ ...options, witnessDir: join(alias, 'witness') }), ProviderStoreHold);
  assert.equal(existsSync(join(parent, 'witness')), false);
}));
