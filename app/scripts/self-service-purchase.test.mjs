import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toHex, hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSelfServicePurchase } from "../src/selfServicePurchase.mjs";
const agent = privateKeyToAccount(`0x${"11".repeat(32)}`),
  provider = privateKeyToAccount(`0x${"22".repeat(32)}`);
const contract = `0x${"33".repeat(20)}`,
  sponsor = `0x${"44".repeat(20)}`,
  lineId = `0x${"55".repeat(32)}`,
  code = "0x6000";
const config = {
  chainId: 5042002,
  account: agent.address,
  contract,
  provider: provider.address,
  runtimeHash: keccak256(code),
  endpoint: "https://example.com/result",
  providerUrl: "https://example.com/provider",
  principal: "50000",
};
const acceptanceTypes = {
  ServiceAcceptance: [
    "digest:bytes32",
    "provider:address",
    "endpointHash:bytes32",
    "principal:uint256",
    "requestIdHash:bytes32",
    "acceptedAt:uint256",
  ].map((x) => {
    const [name, type] = x.split(":");
    return { name, type };
  }),
};
function setup() {
  const data = new Map();
  let sends = 0,
    signs = 0,
    lost = false,
    policy = true,
    status = 0,
    receiptTamper = false;
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  const client = {
    getChainId: async () => 5042002,
    getCode: async () => code,
    getBlock: async () => ({ timestamp: 1000n }),
    readContract: async ({ functionName }) =>
      ({
        lines: {
          agent: agent.address,
          sponsor,
          epoch: 1n,
          state: 1,
          availableReserve: 100000n,
          expiry: 10000n,
          maximumRepaymentWindow: 3600n,
        },
        activeLineId: lineId,
        minimumRepaymentWindow: 60n,
        currentTermsHash: `0x${"66".repeat(32)}`,
        receiptStatus: status,
      })[functionName],
    simulateContract: async () => ({ result: [policy, 0] }),
    verifyTypedData: async (args) => {
      const { verifyTypedData } = await import("viem");
      return verifyTypedData(args);
    },
  };
  const wallet = {
    getChainId: async () => 5042002,
    getAddresses: async () => [agent.address],
    request: async ({ params }) => {
      signs++;
      const t = JSON.parse(params[1]);
      return agent.signTypedData(t);
    },
    sendTransaction: async () => {
      sends++;
      if (lost) throw new Error("wallet disconnected");
      return `0x${"77".repeat(32)}`;
    },
  };
  const fetchImpl = async (url, request) => {
    assert(url.endsWith("/accept"));
    const { intent, requestId } = JSON.parse(request.body);
    const message = {
      digest: intent.digest,
      provider: provider.address,
      endpointHash: intent.typedData.message.endpointHash,
      principal: "50000",
      requestIdHash: keccak256(toHex(requestId)),
      acceptedAt: "1000",
    };
    const typedData = {
      domain: {
        name: "ShadowFloatMainnetProvider",
        version: "1",
        chainId: 5042002,
        verifyingContract: contract,
      },
      types: acceptanceTypes,
      primaryType: "ServiceAcceptance",
      message,
    };
    const signature = await provider.signTypedData(typedData);
    if (receiptTamper) message.principal = "50001";
    return {
      ok: true,
      text: async () => JSON.stringify({ typedData, signature }),
    };
  };
  const create = () =>
    createSelfServicePurchase({
      client,
      wallet,
      config,
      storage,
      fetchImpl,
      withLock: async (_key, work) => work(),
      random: () => new Uint8Array(32).fill(8),
    });
  return {
    create,
    data,
    storage,
    client,
    wallet,
    counts: () => ({ sends, signs }),
    paidStatus: (value) => (status = value),
    lose: () => (lost = true),
    block: () => (policy = false),
    tamperReceipt: () => (receiptTamper = true),
  };
}
test("wallet purchase needs no enrollment token and persists the attempt before an ambiguous response", async () => {
  const h = setup(),
    flow = h.create();
  await flow.prepare(lineId, "job-1");
  h.lose();
  await assert.rejects(flow.submit(), /disconnected/);
  assert.equal(h.counts().sends, 1);
  assert.equal(flow.load().stage, "submitted");
  await assert.rejects(h.create().submit(), /reconciliation/);
  assert.equal(h.counts().sends, 1);
  assert.equal((await h.create().recover()).status, "unconfirmed");
});
test("altered signing payload or changed wallet is rejected before signing", async () => {
  const h = setup(),
    flow = h.create();
  await flow.prepare(lineId, "job-1");
  const [key, raw] = [...h.data][0];
  const value = JSON.parse(raw);
  value.intent.externalSignerTypedData = "{}";
  h.data.set(key, JSON.stringify(value));
  await assert.rejects(flow.submit(), /altered/);
  assert.equal(h.counts().signs, 0);
  h.data.set(key, raw);
  h.wallet.getAddresses = async () => [provider.address];
  await assert.rejects(flow.submit(), /Wallet changed/);
  assert.equal(h.counts().signs, 0);
});
test("invalid provider signature and policy refusal cannot reach transaction request", async () => {
  const h = setup(),
    flow = h.create();
  await flow.prepare(lineId, "job-1");
  h.tamperReceipt();
  await assert.rejects(flow.submit(), /signature/);
  assert.equal(h.counts().sends, 0);
  const j = setup(),
    other = j.create();
  await other.prepare(lineId, "job-2");
  j.block();
  await assert.rejects(other.submit(), /policy refused/);
  assert.equal(j.counts().sends, 0);
});
test("wrong agent, missing persistence and concurrent repeated submissions fail safely", async () => {
  const h = setup(),
    flow = h.create();
  const read = h.client.readContract;
  h.client.readContract = async (args) =>
    args.functionName === "lines"
      ? { ...(await read(args)), agent: provider.address }
      : read(args);
  await assert.rejects(flow.prepare(lineId, "job-1"), /not the agent/);
  h.client.readContract = read;
  h.storage.setItem = () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(flow.prepare(lineId, "job-1"), /storage unavailable/);
  assert.equal(h.counts().signs, 0);
  const j = setup(),
    f = j.create();
  await f.prepare(lineId, "job-2");
  const results = await Promise.allSettled([f.submit(), f.submit()]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(j.counts().sends, 1);
});

test("repayment deadline remains valid through the complete signature lifetime", async () => {
  const h = setup(),
    flow = h.create();
  const r = await flow.prepare(lineId, "job-deadline");
  const m = r.intent.typedData.message;
  assert.equal(BigInt(m.dueAt), BigInt(m.signatureExpiry) + 60n);
});

test("confirmed refusal can be archived but unresolved payments remain held", async () => {
  const h = setup(),
    flow = h.create();
  await flow.prepare(lineId, "job-refusal");
  await assert.rejects(flow.archive(), /confirmed refusal/);
  h.paidStatus(1);
  assert.equal((await flow.recover()).status, "blocked");
  await flow.archive();
  assert.equal(flow.load(), null);
  h.paidStatus(0);
  await flow.prepare(lineId, "job-next");
  assert.equal(flow.load().requestId, "job-next");
});
