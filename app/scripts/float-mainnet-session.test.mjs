import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { keccak256, stringToHex, zeroAddress } from "viem";
import { account } from "./float-mainnet-e2e.mjs";
import { intentDigest } from "./float-mainnet-intent.mjs";
import { runCalls } from "./float-mainnet-cli.mjs";
import { floatAbi } from "./float-mainnet-config.mjs";
import { initializeExecutionSession, readSessionPolicy, requireNamedMainnetExecutor, requireSessionPath, withExecutionSession } from "./float-mainnet-session.mjs";

const h = (value) => keccak256(stringToHex(value));
const CODE = "0x60016000";
const FLOAT = account(12).address;
const CHAIN = 5042n;
const STRUCT = {
  sponsor: account(6).address, agent: account(7).address, provider: account(9).address, executor: account(8).address,
  lineId: h("line"), lineEpoch: 1n, termsHash: h("terms"), endpointHash: h("https://provider.example/service"),
  principal: 300_000n, maximumTotalDebt: 300_000n, dueAt: 2000n, nonce: 1n, signatureExpiry: 1000n,
};
const digestOf = (struct) => intentDigest(CHAIN, FLOAT, struct);

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "shadow-session-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "policy.json");
  const raw = { kind: "ShadowFloatMainnet.ExecutionSession", sessionId: "unit-session", chainId: CHAIN.toString(), verifyingContract: FLOAT, runtimeKeccak256: keccak256(CODE), executor: STRUCT.executor, sponsor: STRUCT.sponsor, agent: STRUCT.agent, provider: STRUCT.provider, endpointHash: STRUCT.endpointHash, maxGrossPrincipal: "600000", ledgerDirectory: "./ledger" };
  writeFileSync(path, JSON.stringify(raw));
  const statuses = new Map();
  const receipts = new Map();
  const reads = [];
  const block = { number: 10n, hash: h("block") };
  const connection = { chainId: CHAIN, address: FLOAT, client: {
    getBlock: async () => block,
    getCode: async () => CODE,
    readContract: async (request) => { reads.push(request); return statuses.get(request.args[0]) ?? 0; },
    getTransactionReceipt: async ({ hash }) => {
      if (receipts.has(hash)) return receipts.get(hash);
      throw Object.assign(new Error("not found"), { name: "TransactionReceiptNotFoundError" });
    },
  } };
  await initializeExecutionSession(path, connection);
  return { dir, path, raw, connection, statuses, receipts, block, reads, ledger: join(dir, "ledger", "ledger.json") };
}

test("mainnet has no unconfigured or wildcard executor path; testnet opt-in remains explicit", () => {
  assert.throws(() => requireSessionPath({}, { chainId: CHAIN }), /requires --session/);
  assert.equal(requireSessionPath({}, { chainId: 5042002n }), null);
  assert.throws(() => requireNamedMainnetExecutor({ chainId: CHAIN }, { executor: zeroAddress }), /nonzero named/);
  assert.doesNotThrow(() => requireNamedMainnetExecutor({ chainId: CHAIN }, STRUCT));
});

test("reservations survive restart, reconcile once per digest and span reopened line epochs", async (t) => {
  const f = await fixture(t);
  const first = digestOf(STRUCT);
  await withExecutionSession(f.path, f.connection, async (s) => { await s.reconcile(); s.reserve(STRUCT, first); });
  await assert.rejects(withExecutionSession(f.path, f.connection, async (s) => { await s.reconcile(); s.check(STRUCT, first); }), /unresolved attempt.*no resend/);
  f.statuses.set(first, 2);
  await withExecutionSession(f.path, f.connection, async (s) => {
    const report = await s.reconcile();
    assert.equal(report.acceptedPrincipal, "300000");
    assert.equal(s.check(STRUCT, first).status, "paid");
    assert.throws(() => s.reserve(STRUCT, first), /never resent/);
    assert.equal(s.report().reservedGrossPrincipal, "300000");
    const epochTwo = { ...STRUCT, lineId: h("new-line"), lineEpoch: 2n, nonce: 2n };
    s.reserve(epochTwo, digestOf(epochTwo));
    f.statuses.set(digestOf(epochTwo), 2);
  });
  await withExecutionSession(f.path, f.connection, async (s) => {
    assert.equal((await s.reconcile()).acceptedPrincipal, "600000");
    const epochThree = { ...STRUCT, lineId: h("third-line"), lineEpoch: 3n, nonce: 3n };
    assert.throws(() => s.reserve(epochThree, digestOf(epochThree)), /budget exhausted.*epoch/);
  });
  assert.ok(f.reads.every((r) => r.blockNumber === 10n && r.functionName === "receiptStatus"));
});

test("lost send/hashless calldata holds new digests and RPC failure never releases capacity", async (t) => {
  const f = await fixture(t);
  await withExecutionSession(f.path, f.connection, (s) => s.reserve(STRUCT, digestOf(STRUCT)));
  const second = { ...STRUCT, nonce: 2n };
  await withExecutionSession(f.path, f.connection, async (s) => {
    await s.reconcile();
    assert.throws(() => s.check(second, digestOf(second)), /unresolved attempt holds/);
    assert.equal(s.report().reservedGrossPrincipal, "300000");
  });
  const saved = readFileSync(f.ledger, "utf8");
  f.connection.client.readContract = async () => { throw new Error("RPC offline"); };
  await assert.rejects(withExecutionSession(f.path, f.connection, (s) => s.reconcile()), /RPC offline/);
  assert.equal(readFileSync(f.ledger, "utf8"), saved);
});

test("a reverted transaction resolves the hold but never recycles or resends its reservation", async (t) => {
  const f = await fixture(t);
  const digest = digestOf(STRUCT);
  const txHash = h("reverted transaction");
  await withExecutionSession(f.path, f.connection, (s) => { s.reserve(STRUCT, digest); s.beforeSend(digest, txHash); });
  f.receipts.set(txHash, { transactionHash: txHash, status: "reverted", blockNumber: 10n, blockHash: f.block.hash });
  await withExecutionSession(f.path, f.connection, async (s) => {
    const report = await s.reconcile();
    assert.equal(report.pending.length, 0);
    assert.equal(report.reservedGrossPrincipal, "300000");
    assert.equal(s.check(STRUCT, digest).status, "reverted");
    assert.throws(() => s.reserve(STRUCT, digest), /never resent/);
  });
});

test("refusals retain budget, and changed canonical outcomes fail closed", async (t) => {
  const f = await fixture(t);
  const digest = digestOf(STRUCT);
  await withExecutionSession(f.path, f.connection, (s) => s.reserve(STRUCT, digest));
  f.statuses.set(digest, 1);
  await withExecutionSession(f.path, f.connection, async (s) => {
    const report = await s.reconcile();
    assert.equal(report.acceptedPrincipal, "0");
    assert.equal(report.remainingGrossPrincipal, "300000");
  });
  f.statuses.set(digest, 0);
  await assert.rejects(withExecutionSession(f.path, f.connection, (s) => s.reconcile()), /previous blocked outcome.*changed/);
});

test("canonical block change during reconciliation cannot persist a tentative paid status", async (t) => {
  const f = await fixture(t);
  await withExecutionSession(f.path, f.connection, (s) => s.reserve(STRUCT, digestOf(STRUCT)));
  f.statuses.set(digestOf(STRUCT), 2);
  let reads = 0;
  f.connection.client.getBlock = async () => ({ ...f.block, hash: ++reads === 1 ? f.block.hash : h("reorg") });
  const saved = readFileSync(f.ledger, "utf8");
  await assert.rejects(withExecutionSession(f.path, f.connection, (s) => s.reconcile()), /canonical block changed/);
  assert.equal(readFileSync(f.ledger, "utf8"), saved);
});

test("missing/corrupt ledger or changed policy cannot be silently initialized/reset", async (t) => {
  const f = await fixture(t);
  await assert.rejects(initializeExecutionSession(f.path, f.connection), /EEXIST/);
  const altered = JSON.parse(readFileSync(f.ledger, "utf8"));
  altered.policyHash = "changed";
  writeFileSync(f.ledger, JSON.stringify(altered));
  await assert.rejects(withExecutionSession(f.path, f.connection, () => {}), /corrupt.*policy changed/);
  writeFileSync(f.ledger, "{truncated");
  await assert.rejects(withExecutionSession(f.path, f.connection, () => {}), /JSON/);
  rmSync(f.ledger);
  await assert.rejects(withExecutionSession(f.path, f.connection, () => {}), /ENOENT/);
  await assert.rejects(initializeExecutionSession(f.path, f.connection), /EEXIST/);
  const fresh = await fixture(t);
  writeFileSync(fresh.path, JSON.stringify({ ...fresh.raw, maxGrossPrincipal: "900000" }));
  await assert.rejects(withExecutionSession(fresh.path, fresh.connection, () => {}), /policy changed/);
});

test("exact deployment, executor, counterparties and endpoint bind every attempt", async (t) => {
  const f = await fixture(t);
  const policy = readSessionPolicy(f.path);
  assert.equal(policy.ledgerDirectory, join(f.dir, "ledger"));
  await withExecutionSession(f.path, f.connection, (s) => {
    for (const key of ["executor", "agent", "sponsor", "provider"]) {
      const altered = { ...STRUCT, [key]: account(14).address };
      assert.throws(() => s.reserve(altered, digestOf(altered)), new RegExp(`intent ${key}`));
    }
    const altered = { ...STRUCT, endpointHash: h("other endpoint") };
    assert.throws(() => s.reserve(altered, digestOf(altered)), /intent endpointHash/);
    assert.throws(() => s.reserve(STRUCT, h("wrong digest")), /digest does not match/);
  });
  f.connection.client.getCode = async () => "0x6000";
  await assert.rejects(withExecutionSession(f.path, f.connection, (s) => s.reconcile()), /runtime does not match/);
  await assert.rejects(withExecutionSession(f.path, { ...f.connection, chainId: 1n }, (s) => s.reconcile()), /different chain/);
});

test("another process cannot enter an active ledger lock", async (t) => {
  const f = await fixture(t);
  const module = new URL("./float-mainnet-session.mjs", import.meta.url).href;
  await withExecutionSession(f.path, f.connection, async () => {
    const code = `import { withExecutionSession } from ${JSON.stringify(module)}; await withExecutionSession(process.argv[1], {}, () => {});`;
    await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, f.path]), /ledger is locked/);
  });
  await withExecutionSession(f.path, f.connection, (s) => assert.equal(s.report().remainingGrossPrincipal, "600000"));
});

test("durability failure in beforeSend prevents any raw transaction broadcast", async () => {
  const sent = [];
  const signer = { mode: "execute", account: account(8), wallet: { prepareTransactionRequest: async () => ({}), signTransaction: async () => "0x1234", sendRawTransaction: async () => sent.push(true) } };
  const connection = { address: FLOAT, client: { simulateContract: async () => ({ result: true }) } };
  const call = { address: FLOAT, abi: floatAbi, functionName: "cancelNonce", args: [STRUCT.lineId, 1n] };
  await assert.rejects(runCalls(connection, signer, [call], { beforeSend: () => { throw new Error("disk full"); } }), /disk full/);
  assert.deepEqual(sent, []);
});
