import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

// This directory is independent of provider backups. Losing or rolling back
// both stores cannot be detected locally and requires operator reconciliation.
export class ProviderStoreHold extends Error {
  constructor(detail) {
    super(`Provider store needs reconciliation: ${detail}`);
    this.status = 409;
  }
}
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const recordName = name => /^(?:0x[0-9a-f]{64}\.[a-z]+|request-0x[0-9a-f]{64})\.json$/.test(name);

export function createStoreWitness({ storeDir, witnessDir, identity, storeOnce, serialize, readOnly = false }) {
  const store = resolve(storeDir), witness = resolve(witnessDir);
  const inside = relative(store, witness);
  const reverse = relative(witness, store);
  if (!inside || (!inside.startsWith(`..${sep}`) && inside !== '..') ||
      (!reverse.startsWith(`..${sep}`) && reverse !== '..')) {
    throw new ProviderStoreHold('the witness must be outside the store and its ancestors');
  }
  const assertDirectory = path => {
    if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) {
      throw new ProviderStoreHold('a store directory is missing, replaced by a link, or not canonical');
    }
  };
  assertDirectory(store);
  assertDirectory(dirname(witness));
  if (!existsSync(witness)) {
    if (readOnly) throw new ProviderStoreHold("recovery mode requires an existing witness");
    if (readdirSync(store).some(name => name.endsWith('.json'))) {
      throw new ProviderStoreHold('an existing store cannot initialize a new witness without verified migration');
    }
    mkdirSync(witness, { mode: 0o700 });
  }
  assertDirectory(witness);
  const storeStat = lstatSync(store), witnessStat = lstatSync(witness);
  const identityFile = join(witness, 'identity.json');
  const expected = { version: 1, identity, store };
  if (!existsSync(identityFile)) {
    if (readOnly) throw new ProviderStoreHold("recovery mode cannot initialize an identity");
    if (readdirSync(witness).length || readdirSync(store).some(name => name.endsWith('.json'))) {
      throw new ProviderStoreHold('a missing identity cannot be reinitialized');
    }
    storeOnce(identityFile, expected);
  }
  const readRegular = file => {
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
      throw new ProviderStoreHold(`missing or unsafe record ${basename(file)}`);
    }
    return readFileSync(file);
  };
  const assertIdentity = () => {
    assertDirectory(store); assertDirectory(witness);
    for (const [path, pinned] of [[store, storeStat], [witness, witnessStat]]) {
      const now = lstatSync(path);
      if (now.dev !== pinned.dev || now.ino !== pinned.ino) throw new ProviderStoreHold('a live directory was replaced');
    }
    if (serialize(JSON.parse(readRegular(identityFile))) !== serialize(expected)) {
      throw new ProviderStoreHold('witness identity does not match this provider deployment');
    }
  };
  const assertConsistent = () => {
    assertIdentity();
    const known = new Set();
    for (const name of readdirSync(witness)) {
      if (name === 'identity.json' || name.endsWith('.tmp')) continue;
      if (!recordName(name)) throw new ProviderStoreHold('unexpected witness record');
      known.add(name);
      const entry = JSON.parse(readRegular(join(witness, name)));
      if (entry.name !== name || entry.sha256 !== checksum(readRegular(join(store, name)))) {
        throw new ProviderStoreHold(`record differs from durable witness: ${name}`);
      }
    }
    for (const name of readdirSync(store)) {
      if (!name.endsWith('.json')) continue;
      if (!recordName(name) || !known.has(name)) throw new ProviderStoreHold(`unwitnessed record: ${name}`);
    }
  };
  assertConsistent();
  return {
    assertConsistent,
    storeOnce(file, value) {
      assertConsistent();
      if (resolve(file) !== join(store, basename(file)) || !recordName(basename(file))) throw new ProviderStoreHold('invalid record path');
      if (existsSync(file)) return false;
      // Publish the witness first. A crash before the provider record becomes
      // durable holds the store; it never silently replays external work.
      const serialized = serialize(value);
      const entry = { name: basename(file), sha256: checksum(serialized) };
      storeOnce(join(witness, basename(file)), entry);
      const kept = JSON.parse(readRegular(join(witness, basename(file))));
      if (kept.sha256 !== entry.sha256 || kept.name !== entry.name) throw new ProviderStoreHold('conflicting witnessed write');
      const result = storeOnce(file, value);
      assertConsistent();
      return result;
    },
  };
}

// Inspection is not approval. The operator must independently reconcile this
// inventory with trusted original records and payment evidence before pinning
// its digest for initialization. Never derive the approved digest implicitly.
export function captureStoreSnapshot({ storeDir, identity }) {
  const store = resolve(storeDir);
  if (realpathSync(store) !== store || !lstatSync(store).isDirectory()) throw new ProviderStoreHold('noncanonical snapshot directory');
  const files = [];
  for (const name of readdirSync(store).sort()) {
    if (name.endsWith('.tmp')) continue;
    const file = join(store, name), info = lstatSync(file);
    if (!recordName(name) || !info.isFile() || info.isSymbolicLink()) throw new ProviderStoreHold('unsafe snapshot record');
    files.push([name, checksum(readFileSync(file))]);
  }
  return { version: 1, store, identity, files };
}

export function initializeStoreWitness({ storeDir, witnessDir, identity, snapshot, approvedSnapshotSha256, storeOnce, serialize }) {
  if (process.platform === 'win32') throw new ProviderStoreHold('migration requires directory durability support');
  if (!/^[a-f0-9]{64}$/.test(approvedSnapshotSha256 ?? '') || checksum(serialize(snapshot)) !== approvedSnapshotSha256) {
    throw new ProviderStoreHold('snapshot lacks its independently approved fingerprint');
  }
  const store = resolve(storeDir), witness = resolve(witnessDir);
  const within = (a, b) => { const path = relative(a, b); return !path || (path !== '..' && !path.startsWith(`..${sep}`)); };
  if (within(store, witness) || within(witness, store)) throw new ProviderStoreHold('unsafe witness location');
  const verify = () => {
    if (serialize(captureStoreSnapshot({ storeDir: store, identity })) !== serialize(snapshot)) {
      throw new ProviderStoreHold('store no longer matches the approved snapshot');
    }
  };
  verify();
  if (realpathSync(dirname(witness)) !== dirname(witness) || !lstatSync(dirname(witness)).isDirectory()) {
    throw new ProviderStoreHold('noncanonical witness parent');
  }
  // Exclusive creation. Any interrupted initialization stays visibly incomplete
  // and refuses retry; an operator must reconcile it, never reset it silently.
  mkdirSync(witness, { mode: 0o700 });
  if (realpathSync(witness) !== witness) throw new ProviderStoreHold('noncanonical witness directory');
  syncParent(witness);
  for (const [name, sha256] of snapshot.files) storeOnce(join(witness, name), { name, sha256 });
  verify();
  // Identity is the final commit marker. storeOnce durably publishes each file
  // and its directory. No active server can initialize a populated store when
  // this marker is absent.
  storeOnce(join(witness, 'identity.json'), { version: 1, identity, store });
  const guard = createStoreWitness({ storeDir: store, witnessDir: witness, identity, storeOnce, serialize });
  guard.assertConsistent();
  return { initialized: true, records: snapshot.files.length, approvedSnapshotSha256 };
}

function syncParent(path) {
  if (process.platform === 'win32') throw new ProviderStoreHold('migration requires directory durability support');
  const fd = openSync(dirname(path), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
