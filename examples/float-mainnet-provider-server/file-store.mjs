import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { storeOnce } from '../../app/scripts/float-mainnet-provider.mjs';
import { stableStringify } from '../../app/scripts/float-mainnet-preflight.mjs';
import { createStoreWitness } from './store-witness.mjs';

// Synchronous persistence boundary. A write must be durable before its caller
// signs or publishes a response. An adapter must never substitute an in-memory
// cache followed by an asynchronous flush for these operations.
export function createFileProviderStore({ directory, identity, witnessDirectory = null, recoveryOnly = false }) {
  if (recoveryOnly) {
    if (!statSync(directory).isDirectory()) throw new Error('Recovery requires an existing store directory');
  } else mkdirSync(directory, { recursive: true });
  const pathOf = name => {
    if (!/^(?:0x[0-9a-f]{64}\.[a-z]+|request-0x[0-9a-f]{64})\.json$/i.test(name)) {
      throw new Error('Invalid provider record name');
    }
    return join(directory, name);
  };
  const witness = witnessDirectory ? createStoreWitness({
    storeDir: directory, witnessDir: witnessDirectory, identity,
    readOnly: recoveryOnly, storeOnce, serialize: value => `${stableStringify(value)}\n`,
  }) : null;
  const persist = witness ? witness.storeOnce : storeOnce;
  return Object.freeze({
    witnessed: witness !== null,
    describe(name) { return pathOf(name); },
    assertConsistent() { witness?.assertConsistent(); },
    list() { return readdirSync(directory); },
    has(name) { return existsSync(pathOf(name)); },
    read(name) {
      const path = pathOf(name);
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    },
    putOnce(name, value) { return persist(pathOf(name), value); },
  });
}
