import { LIMITS } from './limits.ts';
import { ProviderStoreFull, ProviderStoreInvalid } from './errors.ts';

const RECORD_NAME = /^(?:0x[0-9a-f]{64}\.[a-z]+|request-0x[0-9a-f]{64})\.json$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertRecordName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !RECORD_NAME.test(name)) throw new ProviderStoreInvalid('Invalid provider record name');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function sha256OfText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

// Intrinsic accessors. They read the real typed-array slots and ignore any
// overridden getter or method on a caller's subclass, and they throw on a non-typed-array.
const TypedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const slot = (key: string | symbol): { call(target: unknown): unknown } => {
  const getter = Reflect.get(Object.getOwnPropertyDescriptor(TypedArray, key)!, 'get') as (this: unknown) => unknown;
  return { call: target => Reflect.apply(getter, target, []) };
};
const slotTag = slot(Symbol.toStringTag), slotBuffer = slot('buffer'), slotOffset = slot('byteOffset'), slotLength = slot('byteLength');

interface ByteWindow { buffer: ArrayBuffer; offset: number; length: number }

function windowOf(value: unknown): ByteWindow {
  let tag: unknown;
  try { tag = slotTag.call(value); } catch { tag = undefined; }
  if (tag !== 'Uint8Array') throw new ProviderStoreInvalid('Record bytes must be a Uint8Array');
  const buffer = slotBuffer.call(value) as ArrayBuffer;
  // A SharedArrayBuffer can change underneath a synchronous copy. Refuse it.
  if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]') throw new ProviderStoreInvalid('Record bytes must not use shared memory');
  return { buffer, offset: Number(slotOffset.call(value)), length: Number(slotLength.call(value)) };
}

/**
 * The ownership boundary for caller-supplied bytes. Call it BEFORE the first
 * await. It checks type and size first (no large copy for an oversized input),
 * then returns a private copy. Everything after this point, including UTF-8
 * validation, hashing and storage, uses the copy, so later mutation of the
 * caller's buffer cannot reach the store. `budget` is the bytes still allowed in
 * a multi-record import; exceeding it is a ProviderStoreFull, not a copy.
 */
export function ownRecordBytes(value: unknown, budget: number = LIMITS.maxRecordBytes): Uint8Array {
  const { buffer, offset, length } = windowOf(value);
  if (length < 1) throw new ProviderStoreInvalid('Record must not be empty');
  if (length > LIMITS.maxRecordBytes) throw new ProviderStoreInvalid(`Record exceeds ${LIMITS.maxRecordBytes} bytes`);
  if (length > budget) throw new ProviderStoreFull('Import exceeds the total bytes limit');
  const copy = new Uint8Array(length);
  copy.set(new Uint8Array(buffer, offset, length));
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(copy); } catch {
    throw new ProviderStoreInvalid('Record is not valid UTF-8');
  }
  return copy;
}

/** Encode text once, refusing text that UTF-8 cannot represent (lone surrogates). */
export function textToBytes(text: string): Uint8Array {
  if (typeof text !== 'string') throw new ProviderStoreInvalid('Record text must be a string');
  // Every UTF-16 unit encodes to at least one byte, so this bound holds before any encoding work.
  if (text.length > LIMITS.maxRecordBytes) throw new ProviderStoreInvalid(`Record exceeds ${LIMITS.maxRecordBytes} bytes`);
  const bytes = new TextEncoder().encode(text);
  if (new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes) !== text) {
    throw new ProviderStoreInvalid('Text contains unpaired surrogates and has no exact UTF-8 form');
  }
  if (bytes.byteLength < 1) throw new ProviderStoreInvalid('Record must not be empty');
  if (bytes.byteLength > LIMITS.maxRecordBytes) throw new ProviderStoreInvalid(`Record exceeds ${LIMITS.maxRecordBytes} bytes`);
  return bytes;
}

/** A fresh Uint8Array copy of a SQLite BLOB value (ArrayBuffer in workerd). */
export function blobToBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new Error('Stored value is not a BLOB');
}

/** An exact-length ArrayBuffer for binding; a view may sit inside a larger buffer. */
export function bindable(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
