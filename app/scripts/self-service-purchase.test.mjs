import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toHex, hashTypedData, createWalletClient, custom, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSelfServicePurchase, createGuardedMainnetPurchase } from "../src/selfServicePurchase.mjs";
import { assertPurchaseResolved } from "../src/gatewayFundingGuard.ts";
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
function setup({mainnet=false,providerCode='0x',bindingVersion=2n}={}) {
  const selectedConfig = mainnet ? {...config,chainId:5042,principal:'5000'} : config;
  const data = new Map();
  let now = 1000n;
  let sends = 0,
    signs = 0,
    lost = false,
    policy = true,
    status = 0,
    receiptTamper = false;
  const storage = {
    get length() { return data.size; },
    key: index => [...data.keys()][index] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  const client = {
    getChainId: async () => selectedConfig.chainId,
    getCode: async ({address}) => address.toLowerCase()===contract.toLowerCase()?code:providerCode,
    getBlock: async () => ({ number: 123n, timestamp: now }),
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
        repaymentBindingVersion: bindingVersion,
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
    getChainId: async () => selectedConfig.chainId,
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
      principal: selectedConfig.principal,
      requestIdHash: keccak256(toHex(requestId)),
      acceptedAt: "1000",
    };
    const typedData = {
      domain: {
        name: "ShadowFloatMainnetProvider",
        version: "1",
        chainId: selectedConfig.chainId,
        verifyingContract: contract,
      },
      types: acceptanceTypes,
      primaryType: "ServiceAcceptance",
      message,
    };
    const signature = await provider.signTypedData(typedData);
    if (receiptTamper) message.principal = "50001";
    return new Response(JSON.stringify({ typedData, signature }));
  };
  const create = (withLock = async (_key, work) => work()) =>
    (mainnet?createGuardedMainnetPurchase:createSelfServicePurchase)({
      client,
      wallet,
      config: selectedConfig,
      storage,
      fetchImpl,
      withLock,
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
    advance: (value) => (now = value),
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

test('an unrelated funding hold blocks signing but permits read only recovery and verified expiry archive',async()=>{
 const h=setup();let held=false;
 const lock=async(_key,work,operation)=>{
   if(held && (operation==='prepare'||operation==='submit'))throw Error('unresolved funding');
   return work();
 };
 const flow=h.create(lock);
 await flow.prepare(lineId,'held-funding-recovery');
 held=true;await assert.rejects(flow.submit(),/unresolved funding/);
 assert.deepEqual(h.counts(),{sends:0,signs:0});
 held=true;
 const before=h.counts();
 assert.equal((await flow.recover()).status,'unconfirmed');
 h.advance(2000n);await flow.archive();assert.equal(flow.load(),null);
 assert.deepEqual(h.counts(),before);
 await assert.rejects(flow.prepare(lineId,'another'),/unresolved funding/);
});

test('a conflicting deployment appearing after review blocks signing without blocking the current intent',async()=>{
 const h=setup();
 const lock=async(key,work,operation)=>{
   if(operation!=='recover' && operation!=='archive')assertPurchaseResolved(agent.address,h.storage,5042002,key);
   return work();
 };
 const flow=h.create(lock),otherKey=`shadow.public-purchase.v1:5042002:0x${'aa'.repeat(20)}:${agent.address}`;
 h.data.set(otherKey,JSON.stringify({stage:'submitted'}));
 await assert.rejects(flow.prepare(lineId,'cross-route'),/earlier purchase/);
 assert.deepEqual(h.counts(),{sends:0,signs:0});
 h.data.delete(otherKey);await flow.prepare(lineId,'cross-route');
 h.data.set(otherKey,JSON.stringify({stage:'submitted'}));
 await assert.rejects(flow.submit(),/earlier purchase/);
 assert.deepEqual(h.counts(),{sends:0,signs:0});
 h.data.delete(otherKey);await flow.submit();
 assert.deepEqual(h.counts(),{sends:1,signs:1});
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
  assert.equal(BigInt(m.dueAt), 4600n);
  assert.ok(BigInt(m.dueAt) >= BigInt(m.signatureExpiry) + 60n);
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

test("lost wallet response remains held until its unpaid authorization expires", async () => {
  const h = setup(),
    flow = h.create();
  await flow.prepare(lineId, "job-expiry");
  h.lose();
  await assert.rejects(flow.submit(), /disconnected/);
  h.advance(1600n);
  await assert.rejects(flow.archive(), /confirmed refusal/);
  h.advance(1601n);
  await flow.archive();
  assert.equal(flow.load(), null);
});

test("purchase caps the due time at line expiry and rejects an unusable minimum window", async () => {
  const h=setup();
  const original=h.client.readContract;
  let expiry=3000n;
  h.client.readContract=async (args)=>args.functionName==='lines'?{...await original(args),expiry}:original(args);
  const record=await h.create().prepare(`  ${lineId}\n`, 'job-expiry');
  assert.equal(record.intent.typedData.message.lineId,lineId);
  assert.equal(BigInt(record.intent.typedData.message.dueAt),3000n);
  const short=setup();
  const read=short.client.readContract;
  short.client.readContract=async(args)=>args.functionName==='lines'?{...await read(args),expiry:1659n}:read(args);
  await assert.rejects(short.create().prepare(lineId,'job-too-short'),/repayment window is too short/);
  assert.equal(short.counts().signs,0);
});


test('guarded mainnet refuses smart providers, wrong repayment binding and network misuse before signing',async()=>{
  for(const patch of [{providerCode:'0x6001'},{bindingVersion:1n}]){
    const h=setup({mainnet:true,...patch});await assert.rejects(()=>h.create().prepare(lineId,'bounded-1'));
    assert.deepEqual(h.counts(),{sends:0,signs:0});
  }
  const h=setup({mainnet:true});const flow=h.create();await flow.prepare(lineId,'bounded-2');
  assert.equal(flow.load().intent.typedData.domain.chainId,5042);
  assert.equal(flow.load().intent.typedData.message.principal,'5000');
  assert.throws(()=>createSelfServicePurchase({config:{...config,chainId:5042}}),/testnet/);
  for(const patch of [{chainId:5042002},{principal:'5001'},{principal:'0'}]){
    assert.throws(()=>createGuardedMainnetPurchase({config:{...config,chainId:5042,principal:'5000',...patch}}));
  }
});

for (const mainnet of [false, true]) test(`wrapped wallet rejection permits explicit retry on ${mainnet ? 'mainnet' : 'testnet'}`, async () => {
  const h = setup({mainnet});
  const chainId = mainnet ? 5042 : 5042002;
  let requests = 0;
  const chain = defineChain({id: chainId, name: 'Local wallet fixture', nativeCurrency: {name:'USDC',symbol:'USDC',decimals:18}, rpcUrls:{default:{http:['http://127.0.0.1:1']}}});
  const wallet = createWalletClient({account:agent.address,chain,transport:custom({request:async ({method})=>{
    if (method === 'eth_chainId') return toHex(chainId);
    if (method === 'eth_sendTransaction') { requests++; throw Object.assign(new Error('User rejected'), {code:4001}); }
    throw new Error(`Unexpected fixture method: ${method}`);
  }})});
  h.wallet.sendTransaction = request => wallet.sendTransaction({...request,chain});
  const flow=h.create();
  await flow.prepare(lineId,'rejection-retry');
  await assert.rejects(flow.submit());
  assert.equal(requests,1);
  assert.equal(flow.load().stage,'accepted');
  const digest=flow.load().intent.digest;
  await assert.rejects(flow.submit());
  assert.equal(requests,2,'only a second explicit submit requests another approval');
  assert.equal(flow.load().stage,'accepted');
  assert.equal(flow.load().intent.digest,digest);
});

test('unknown cyclic wallet errors retain the purchase reconciliation barrier', async()=>{
  const h=setup(); const error=new Error('Unknown wallet failure'); error.cause=error;
  h.wallet.sendTransaction=async()=>{throw error};
  const flow=h.create(); await flow.prepare(lineId,'cyclic-wallet-error');
  await assert.rejects(flow.submit());
  assert.equal(flow.load().stage,'submitted');
  await assert.rejects(flow.submit(),/reconciliation/);
});
