import assert from 'node:assert/strict';
import { ProviderStoreBusy, ProviderStoreFull, ProviderStoreHold, ProviderStoreInvalid } from '../../src/errors.ts';

type Ctor = abstract new (...args: never[]) => Error;

async function rejectsWith(promise: Promise<unknown> | (() => unknown), kind: Ctor, pattern?: RegExp): Promise<void> {
  await assert.rejects(Promise.resolve().then(() => (typeof promise === 'function' ? promise() : promise)), (error: unknown) => {
    assert.ok(error instanceof kind, `expected ${kind.name}, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    if (pattern) assert.match((error as Error).message, pattern);
    return true;
  });
}

export const assertHold = (p: Promise<unknown> | (() => unknown), pattern?: RegExp) => rejectsWith(p, ProviderStoreHold, pattern);
export const assertBusy = (p: Promise<unknown> | (() => unknown), pattern?: RegExp) => rejectsWith(p, ProviderStoreBusy, pattern);
export const assertInvalid = (p: Promise<unknown> | (() => unknown), pattern?: RegExp) => rejectsWith(p, ProviderStoreInvalid, pattern);
export const assertFull = (p: Promise<unknown> | (() => unknown), pattern?: RegExp) => rejectsWith(p, ProviderStoreFull, pattern);

/** Let every currently runnable continuation run. */
export const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail(`timed out waiting for: ${label}`);
}
