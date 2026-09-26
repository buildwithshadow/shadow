import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAddress, hashTypedData, isAddress, keccak256, zeroAddress } from "viem";
import { SPEND_INTENT_TYPES, eip712Domain, floatAbi } from "./float-mainnet-config.mjs";

// A single executor's local policy, not a global Solidity spending restriction.
// Reservations never recycle: even a refusal/revert consumes conservative gross
// capacity. Unknown outcomes block every new submission until reconciled.
const KIND = "ShadowFloatMainnet.ExecutionSession";
const LEDGER_KIND = `${KIND}.Ledger`;
const UINT = /^(0|[1-9][0-9]*)$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message) => { throw new Error(`execution session: ${message}`); };
const decimal = (value, label, positive = true) => {
  if (typeof value !== "string" || !UINT.test(value) || BigInt(value) >= 2n ** 256n || (positive && BigInt(value) === 0n)) fail(`${label} must be a ${positive ? "positive " : ""}decimal integer string`);
  return value;
};
const address = (value, label) => {
  if (typeof value !== "string" || !isAddress(value) || getAddress(value) === zeroAddress) fail(`${label} must be a nonzero address`);
  return getAddress(value);
};
const bytes32 = (value, label) => {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${label} must be a bytes32`);
  return value.toLowerCase();
};

export function readSessionPolicy(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const fields = ["kind", "sessionId", "chainId", "verifyingContract", "runtimeKeccak256", "executor", "sponsor", "agent", "provider", "endpointHash", "maxGrossPrincipal", "ledgerDirectory"];
  if (!raw || Object.keys(raw).some((key) => !fields.includes(key)) || fields.some((key) => raw[key] === undefined)) fail("policy fields are missing or unexpected");
  if (raw.kind !== KIND || typeof raw.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(raw.sessionId)) fail("invalid policy kind or sessionId");
  if (typeof raw.ledgerDirectory !== "string" || !raw.ledgerDirectory.trim()) fail("ledgerDirectory is required");
  const policy = {
    kind: KIND,
    sessionId: raw.sessionId,
    chainId: decimal(raw.chainId, "chainId"),
    verifyingContract: address(raw.verifyingContract, "verifyingContract"),
    runtimeKeccak256: bytes32(raw.runtimeKeccak256, "runtimeKeccak256"),
    executor: address(raw.executor, "executor"),
    sponsor: address(raw.sponsor, "sponsor"),
    agent: address(raw.agent, "agent"),
    provider: address(raw.provider, "provider"),
    endpointHash: bytes32(raw.endpointHash, "endpointHash"),
    maxGrossPrincipal: decimal(raw.maxGrossPrincipal, "maxGrossPrincipal"),
    ledgerDirectory: resolve(dirname(resolve(path)), raw.ledgerDirectory),
  };
  return policy;
}

export function requireSessionPath(values, connection) {
  if (connection.chainId === 5042n && !values.session) fail("Arc mainnet requires --session <policy.json>; initialize its ledger explicitly before using submit");
  return values.session ?? null;
}

export function requireNamedMainnetExecutor(connection, struct) {
  if (connection.chainId === 5042n && struct.executor === zeroAddress) fail("Arc mainnet intents require a nonzero named --executor");
}

// Preparing/signing checks the same policy and available budget, but does not
// reserve it. Only the serialized submit operation may reserve an attempt.
export async function inspectSessionIntent(values, connection, struct, digest) {
  requireNamedMainnetExecutor(connection, struct);
  const path = requireSessionPath(values, connection);
  if (!path) return null;
  return withExecutionSession(path, connection, async (session) => {
    await session.reconcile();
    session.check(struct, digest);
    return session.report();
  });
}

export function assertSessionIntent(policy, connection, struct) {
  if (policy.chainId !== connection.chainId.toString() || policy.verifyingContract !== connection.address) fail("policy is for a different chain or contract");
  for (const name of ["executor", "sponsor", "agent", "provider", "endpointHash"]) {
    if (struct[name].toLowerCase() !== policy[name].toLowerCase()) fail(`intent ${name} does not match the session policy`);
  }
  if (struct.principal <= 0n || struct.principal > BigInt(policy.maxGrossPrincipal)) fail("intent principal exceeds the session gross budget or is zero");
}

function regular(path, type) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !(type === "directory" ? stat.isDirectory() : stat.isFile())) fail(`${path} must be a real ${type}, not a symlink`);
}

// fsync file, atomic rename, fsync parent: a successful call has persisted the
// reservation before any transaction can be broadcast. Never auto-create here.
function saveLedger(policy, entries) {
  const body = { kind: LEDGER_KIND, policyHash: hash(policy), entries };
  const destination = join(policy.ledgerDirectory, "ledger.json");
  const temporary = join(policy.ledgerDirectory, `.ledger-${randomBytes(12).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ ...body, checksum: hash(body) }) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, destination);
  const parent = openSync(policy.ledgerDirectory, "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

function loadLedger(policy) {
  regular(policy.ledgerDirectory, "directory");
  const path = join(policy.ledgerDirectory, "ledger.json");
  regular(path, "file");
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  const { checksum, ...body } = ledger;
  if (ledger.kind !== LEDGER_KIND || ledger.policyHash !== hash(policy) || checksum !== hash(body) || !Array.isArray(ledger.entries)) fail("ledger is corrupt or its policy changed; restore the original verified state, never reset it");
  const digests = new Set();
  for (const entry of ledger.entries) {
    const message = entry.message;
    if (!message || Object.keys(message).length !== SPEND_INTENT_TYPES.SpendIntent.length) fail("corrupt ledger intent");
    const struct = {};
    for (const { name, type } of SPEND_INTENT_TYPES.SpendIntent) {
      struct[name] = type === "address" ? address(message[name], name) : type === "bytes32" ? bytes32(message[name], name) : BigInt(decimal(message[name], name, false));
      if (type.startsWith("uint") && struct[name] >= 2n ** BigInt(type.slice(4))) fail(`corrupt ledger ${name}`);
    }
    assertSessionIntent(policy, { chainId: BigInt(policy.chainId), address: policy.verifyingContract }, struct);
    const digest = hashTypedData({ domain: eip712Domain(policy.chainId, policy.verifyingContract), types: SPEND_INTENT_TYPES, primaryType: "SpendIntent", message: struct });
    if (entry.digest !== digest || digests.has(digest) || !["pending", "paid", "blocked", "reverted"].includes(entry.status)) fail("corrupt or duplicate ledger digest/status");
    if (entry.txHash !== null) bytes32(entry.txHash, "transaction hash");
    if (entry.status === "reverted" && entry.txHash === null) fail("reverted ledger entry has no transaction hash");
    digests.add(digest);
  }
  if (ledger.entries.reduce((total, entry) => total + BigInt(entry.message.principal), 0n) > BigInt(policy.maxGrossPrincipal)) fail("ledger exceeds its gross budget");
  return ledger.entries;
}

async function pinnedConnection(policy, connection) {
  if (connection.chainId.toString() !== policy.chainId || connection.address !== policy.verifyingContract) fail("policy is for a different chain or contract");
  const block = await connection.client.getBlock({ blockTag: "latest" });
  if (block.number === null || !block.hash) fail("RPC did not return a canonical block");
  const code = await connection.client.getCode({ address: connection.address, blockNumber: block.number });
  if (!code || code === "0x" || keccak256(code) !== policy.runtimeKeccak256) fail("candidate runtime does not match the session policy");
  return block;
}

export async function initializeExecutionSession(path, connection) {
  const policy = readSessionPolicy(path);
  await pinnedConnection(policy, connection);
  // Existing directory (even if ledger.json is missing) is a hard failure.
  // Explicitly creating a new policy/directory is a new operator-authorized
  // session; the tool cannot protect against deleting/backdating all local data.
  mkdirSync(policy.ledgerDirectory, { mode: 0o700 });
  saveLedger(policy, []);
  const parent = openSync(dirname(policy.ledgerDirectory), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return { ok: true, status: "session-initialized", sessionId: policy.sessionId, ledgerDirectory: policy.ledgerDirectory, maxGrossPrincipal: policy.maxGrossPrincipal };
}

export async function withExecutionSession(path, connection, callback) {
  const policy = readSessionPolicy(path);
  regular(policy.ledgerDirectory, "directory");
  const lock = join(policy.ledgerDirectory, ".lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") fail("ledger is locked; another process or an interrupted operation owns it. Do not remove the lock until the executor is stopped and the ledger/chain reconciled"); throw error; }
  try {
    let entries = loadLedger(policy);
    const report = () => {
      const reserved = entries.reduce((total, entry) => total + BigInt(entry.message.principal), 0n);
      return { sessionId: policy.sessionId, maxGrossPrincipal: policy.maxGrossPrincipal, reservedGrossPrincipal: reserved.toString(), acceptedPrincipal: entries.filter((e) => e.status === "paid").reduce((total, e) => total + BigInt(e.message.principal), 0n).toString(), remainingGrossPrincipal: (BigInt(policy.maxGrossPrincipal) - reserved).toString(), pending: entries.filter((e) => e.status === "pending").map(({ digest, txHash }) => ({ digest, txHash })) };
    };
    const reconcile = async () => {
      const block = await pinnedConnection(policy, connection);
      const updated = [];
      for (const entry of entries) {
        const receiptStatus = Number(await connection.client.readContract({ address: connection.address, abi: floatAbi, functionName: "receiptStatus", args: [entry.digest], blockNumber: block.number }));
        if (![0, 1, 2].includes(receiptStatus)) fail("unrecognized onchain receipt status");
        let status = receiptStatus === 2 ? "paid" : receiptStatus === 1 ? "blocked" : "pending";
        if (["paid", "blocked"].includes(entry.status) && entry.status !== status) fail(`previous ${entry.status} outcome for ${entry.digest} changed; hold and reconcile chain history`);
        if (status === "pending" && entry.txHash !== null) {
          let receipt;
          try { receipt = await connection.client.getTransactionReceipt({ hash: entry.txHash }); }
          catch (error) { if (error.name !== "TransactionReceiptNotFoundError") throw error; }
          if (receipt && receipt.blockNumber <= block.number && receipt.status === "reverted") {
            const canonical = await connection.client.getBlock({ blockNumber: receipt.blockNumber });
            if (receipt.transactionHash.toLowerCase() !== entry.txHash || canonical.hash !== receipt.blockHash) fail("reverted transaction receipt is not canonical");
            status = "reverted";
          }
        }
        if (entry.status === "reverted" && status === "pending") fail(`previous reverted transaction for ${entry.digest} is no longer canonical; hold`);
        updated.push({ ...entry, status });
      }
      if ((await connection.client.getBlock({ blockNumber: block.number })).hash !== block.hash) fail("canonical block changed while reconciling; hold and retry the read");
      saveLedger(policy, updated);
      entries = updated;
      return { ...report(), observedAt: { blockNumber: block.number.toString(), blockHash: block.hash } };
    };
    const check = (struct, digest) => {
      assertSessionIntent(policy, connection, struct);
      if (hashTypedData({ domain: eip712Domain(policy.chainId, policy.verifyingContract), types: SPEND_INTENT_TYPES, primaryType: "SpendIntent", message: struct }) !== digest) fail("intent digest does not match its session-bound message");
      const prior = entries.find((entry) => entry.digest === digest);
      if (prior) {
        if (prior.status === "pending") fail(`digest ${digest} has an unresolved attempt${prior.txHash ? ` (${prior.txHash})` : " without a returned transaction hash"}; no resend. Reconcile the original outcome`);
        return prior;
      }
      if (entries.some((entry) => entry.status === "pending")) fail("an unresolved attempt holds this session; reconcile it before any new submission");
      if (struct.principal > BigInt(report().remainingGrossPrincipal)) fail("session gross principal budget exhausted; repayment or a new line epoch does not reset it");
      return null;
    };
    return await callback({
      policy, report, reconcile, check,
      reserve(struct, digest) {
        if (check(struct, digest)) fail("recorded session digest is never resent");
        const message = Object.fromEntries(SPEND_INTENT_TYPES.SpendIntent.map(({ name }) => [name, typeof struct[name] === "bigint" ? struct[name].toString() : struct[name]]));
        entries = [...entries, { digest, message, status: "pending", txHash: null }];
        saveLedger(policy, entries);
      },
      beforeSend(digest, txHash) {
        bytes32(txHash, "transaction hash");
        const entry = entries.find((entry) => entry.digest === digest);
        if (!entry || entry.status !== "pending" || entry.txHash !== null) fail("attempt is not eligible for its first broadcast");
        entries = entries.map((e) => e === entry ? { ...e, txHash: txHash.toLowerCase() } : e);
        saveLedger(policy, entries);
      },
    });
  } finally { rmSync(lock, { recursive: true }); }
}
