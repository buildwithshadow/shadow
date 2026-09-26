import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const checksum = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const KIND = "Shadow.PurchaseStore.v1";
function regular(path, directory = false) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile())) throw new Error("purchase store must use real files and directories");
}
export function atomicJson(path, value) {
  const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, path);
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
function save(directory, binding, records) {
  const body = { kind: KIND, binding, records };
  atomicJson(join(directory, "purchases.json"), { ...body, checksum: checksum(body) });
}
export function initializePurchaseStore(directory, binding) {
  // Never create a replacement for an existing, even empty, store.
  mkdirSync(directory, { mode: 0o700 });
  save(directory, binding, []);
  const parent = openSync(dirname(directory), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function openPurchaseStore(directory, binding) {
  regular(directory, true);
  const lock = join(directory, ".service-lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    const path = join(directory, "purchases.json");
    regular(path);
    const { checksum: actual, ...body } = JSON.parse(readFileSync(path, "utf8"));
    if (body.kind !== KIND || body.binding !== binding || checksum(body) !== actual || !Array.isArray(body.records)) throw new Error("purchase store corrupt or configuration changed; preserve and reconcile, never reset");
    const ids = new Set(), requests = new Set();
    for (const record of body.records) {
      if (!/^[a-f0-9]{32}$/.test(record.id) || typeof record.requestId !== "string" || ids.has(record.id) || requests.has(record.requestId) || !record.intent || typeof record.attempted !== "boolean") throw new Error("invalid purchase record");
      ids.add(record.id); requests.add(record.requestId);
    }
    let records = body.records;
    let expected = actual;
    return {
      all: () => structuredClone(records),
      put(record) {
        regular(path);
        const { checksum: current, ...currentBody } = JSON.parse(readFileSync(path, "utf8"));
        if (current !== expected || checksum(currentBody) !== expected) throw new Error("purchase store changed while running; stop and reconcile");
        const next = records.filter((r) => r.id !== record.id).concat(structuredClone(record));
        save(directory, binding, next); // memory advances only after durable write
        records = next;
        expected = checksum({ kind: KIND, binding, records });
      },
      close() { rmSync(lock, { recursive: true }); },
    };
  } catch (error) { rmSync(lock, { recursive: true }); throw error; }
}
