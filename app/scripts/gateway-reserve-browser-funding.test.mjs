import test from "node:test";
import assert from "node:assert/strict";
import { encodePacked, encodeEventTopics, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createGatewayBrowserFunding } from "./gateway-reserve-browser-funding.mjs";
import { createGatewayBrowserJournal } from "./gateway-reserve-browser-journal.mjs";
import {
  GATEWAY_TESTNET as g,
  gatewayAbi,
  transferSpecHash,
} from "./gateway-reserve.mjs";
const signer = privateKeyToAccount("0x" + "01".padStart(64, "0"));
const hash = "0x" + "ab".repeat(32),
  blockHash = "0x" + "cd".repeat(32);
function payload(i) {
  const s = i.spec;
  const encoded = encodePacked(
    [
      "bytes4",
      "uint32",
      "uint32",
      "uint32",
      ...Array(8).fill("bytes32"),
      "uint256",
      "bytes32",
      "uint32",
    ],
    [
      "0xca85def7",
      1,
      26,
      26,
      s.sourceContract,
      s.destinationContract,
      s.sourceToken,
      s.destinationToken,
      s.sourceDepositor,
      s.destinationRecipient,
      s.sourceSigner,
      s.destinationCaller,
      BigInt(s.value),
      s.salt,
      0,
    ],
  );
  return encodePacked(
    ["bytes4", "uint256", "uint32", "bytes"],
    ["0xff6fb334", 1000n, 340, encoded],
  );
}
function fixture() {
  const data = new Map(),
    held = new Set();
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  const locks = {
    async request(k, o, fn) {
      if (held.has(k)) return fn(null);
      held.add(k);
      try {
        return await fn({ name: k });
      } finally {
        held.delete(k);
      }
    },
  };
  const journal = createGatewayBrowserJournal({
    account: signer.address,
    storage,
    locks,
  });
  const state = {
    sends: 0,
    posts: 0,
    signs: 0,
    head: 200n,
    balance: "0.2",
    reject: false,
    loseMint: false,
    loseApi: false,
    account: signer.address,
  };
  const client = {
    getChainId: async () => g.chainId,
    getCode: async ({ address }) =>
      address === signer.address ? "0x" : "0x1234",
    readContract: async () => g.domain,
    getBlockNumber: async () => state.head,
    simulateContract: async () => ({}),
    getBlock: async () => ({ number: 200n, hash: blockHash }),
    getTransaction: async () => ({
      from: signer.address,
      to: g.minter,
      input: state.tx.data,
      nonce: 4,
      value: 0n,
    }),
    getTransactionReceipt: async ({ hash: h }) => {
      const i = journal.load().intent;
      return {
        transactionHash: h,
        to: g.minter,
        status: "success",
        blockNumber: 199n,
        blockHash,
        logs: [
          {
            address: g.minter,
            topics: encodeEventTopics({
              abi: gatewayAbi,
              eventName: "AttestationUsed",
              args: {
                token: g.token,
                recipient: signer.address,
                transferSpecHash: transferSpecHash(i.spec),
              },
            }),
            data: encodeAbiParameters(
              [
                { type: "uint32" },
                { type: "bytes32" },
                { type: "bytes32" },
                { type: "uint256" },
              ],
              [
                26,
                i.spec.sourceDepositor,
                i.spec.sourceSigner,
                BigInt(i.spec.value),
              ],
            ),
          },
        ],
      };
    },
  };
  const wallet = {
    chain: { id: g.chainId },
    getChainId: async () => g.chainId,
    getAddresses: async () => [state.account],
    request: async () => "0x4",
    signTypedData: async (args) => {
      state.signs++;
      return signer.signTypedData(args);
    },
    sendTransaction: async (args) => {
      state.sends++;
      state.tx = args;
      if (state.reject) throw Object.assign(Error("declined"), { code: 4001 });
      if (state.loseMint) throw Error("response lost after mint");
      return hash;
    },
  };
  const read = async (path, body) => {
    if (path === "/info")
      return {
        domains: [
          {
            domain: 26,
            walletContract: { address: g.wallet },
            minterContract: { address: g.minter },
            burnIntentExpirationHeight: "10000",
          },
        ],
      };
    if (path === "/estimate") {
      const i = structuredClone(body[0]);
      for (const key of [
        "sourceContract",
        "destinationContract",
        "sourceToken",
        "destinationToken",
        "sourceDepositor",
        "destinationRecipient",
        "sourceSigner",
        "destinationCaller",
      ])
        i.spec[key] = "0x" + i.spec[key].slice(-40);
      if (state.alterEstimate)
        i.spec.destinationRecipient = "0x" + "22".repeat(20);
      return [{ burnIntent: { ...i, maxFee: "1000" } }];
    }
    if (path === "/balances")
      return {
        balances: [
          { domain: 26, depositor: signer.address, balance: state.balance },
        ],
      };
    throw Error("unexpected endpoint");
  };
  const fetchImpl = async (url, options) => {
    state.posts++;
    assert.equal(url, g.api + "/transfer");
    assert.equal(options.method, "POST");
    const [{ burnIntent }] = JSON.parse(options.body);
    if (state.loseApi) throw Error("lost API response");
    return {
      ok: true,
      json: async () => ({
        attestation: payload(burnIntent),
        signature: "0x1234",
      }),
    };
  };
  const options = {
    account: signer.address,
    wallet,
    clients: [client, { ...client }],
    journal,
    read,
    fetchImpl,
  };
  return {
    state,
    journal,
    options,
    engine: createGatewayBrowserFunding(options),
    client,
    wallet,
  };
}
test("existing Gateway balance can authorize and mint once with exact receipt identity", async () => {
  const x = fixture(),
    plan = await x.engine.quote("100000");
  assert.equal(plan.intent.maxFee, "1000");
  assert.equal(x.journal.load(), null);
  await x.engine.authorize(plan);
  await x.engine.authorize(plan);
  assert.equal((await x.engine.mint()).evidence.event, "AttestationUsed");
  await x.engine.mint();
  assert.equal(x.state.posts, 1);
  assert.equal(x.state.signs, 1);
  assert.equal(x.state.sends, 1);
});
test("lost API response remains held across reload without another signature or POST", async () => {
  const x = fixture(),
    plan = await x.engine.quote("100000");
  x.state.loseApi = true;
  await assert.rejects(x.engine.authorize(plan), /lost API/);
  const resumed = createGatewayBrowserFunding(x.options);
  assert.equal((await resumed.authorize(plan)).status, "unknown");
  assert.equal((await resumed.recover()).status, "unknown");
  await assert.rejects(resumed.mint(), /Confirm/);
  assert.equal(x.state.posts, 1);
  assert.equal(x.state.signs, 1);
  assert.equal(x.state.sends, 0);
});
test("mined mint with lost wallet response recovers by original hash without another send", async () => {
  const x = fixture();
  await x.engine.authorize(await x.engine.quote("100000"));
  x.state.loseMint = true;
  await assert.rejects(x.engine.mint(), /lost after mint/);
  const resumed = createGatewayBrowserFunding(x.options);
  assert.equal((await resumed.mint()).status, "unknown");
  assert.equal((await resumed.recover(hash)).evidence.event, "AttestationUsed");
  assert.equal(x.state.sends, 1);
});
test("explicit wallet rejection can be reviewed again, uncertain sends cannot be reset", async () => {
  const x = fixture();
  await x.engine.authorize(await x.engine.quote("100000"));
  x.state.reject = true;
  assert.equal((await x.engine.mint()).evidence.notSubmitted, true);
  x.state.reject = false;
  assert.equal((await x.engine.mint()).evidence.event, "AttestationUsed");
  assert.equal(x.state.sends, 2);
  assert.equal(x.journal.load().unsentMints.length, 1);
  await assert.rejects(x.journal.retryUnsentMint(), /uncertain/);
  const y = fixture();
  await y.engine.authorize(await y.engine.quote("100000"));
  y.state.loseMint = true;
  await assert.rejects(y.engine.mint());
  await assert.rejects(y.journal.retryUnsentMint(), /uncertain/);
});
test("insufficient Gateway funds and wallet account changes prevent authorization", async () => {
  const x = fixture();
  x.state.balance = "0.1";
  await assert.rejects(x.engine.quote("100000"), /Not enough/);
  x.state.balance = "0.2";
  const p = await x.engine.quote("100000");
  x.state.account = "0x" + "22".repeat(20);
  await assert.rejects(x.engine.authorize(p), /wallet changed/);
  assert.equal(x.state.posts, 0);
  assert.equal(x.state.sends, 0);
});
test("expired attestation and mismatched original transaction cannot be accepted", async () => {
  const x = fixture();
  await x.engine.authorize(await x.engine.quote("100000"));
  x.state.head = 1000n;
  await assert.rejects(x.engine.mint(), /expired/);
  assert.equal(x.state.sends, 0);
  x.state.head = 200n;
  x.state.loseMint = true;
  await assert.rejects(x.engine.mint());
  x.client.getTransaction = async () => ({
    from: signer.address,
    to: g.minter,
    input: x.state.tx.data,
    nonce: 5,
    value: 0n,
  });
  await assert.rejects(x.engine.recover(hash), /not the saved/);
  assert.equal(x.state.sends, 1);
});

test("short API addresses normalize but changed recipients fail before signing", async () => {
  const x = fixture();
  assert.equal(
    (await x.engine.quote("100000")).intent.spec.destinationRecipient.length,
    66,
  );
  x.state.alterEstimate = true;
  await assert.rejects(x.engine.quote("100000"), /changed more/);
  assert.equal(x.state.signs, 0);
  assert.equal(x.state.posts, 0);
});

test("only a freshly verified completed mint can be archived for another withdrawal", async () => {
  const x = fixture();
  await x.engine.authorize(await x.engine.quote("100000"));
  await assert.rejects(x.engine.archive(), /No saved/);
  x.state.loseMint = true;
  await assert.rejects(x.engine.mint());
  await assert.rejects(x.journal.archiveMint(), /verified/);
  await x.engine.recover(hash);
  await x.engine.archive();
  assert.equal(x.journal.load(), null);
  assert.equal(x.state.sends, 1);
  assert.equal(x.state.posts, 1);
  const next = await x.engine.quote("50000");
  assert.equal(next.intent.spec.value, "50000");
});

test("saved API response can recover after temporary RPC failure without another POST", async () => {
  const x = fixture();
  const plan = await x.engine.quote("100000");
  const original = x.client.getBlockNumber;
  x.client.getBlockNumber = async () => {
    throw Error("RPC offline");
  };
  await assert.rejects(x.engine.authorize(plan), /offline/);
  x.client.getBlockNumber = original;
  assert.equal((await x.engine.recover()).status, "confirmed");
  assert.equal(x.state.posts, 1);
  assert.equal(x.state.signs, 1);
  assert.equal(x.state.sends, 0);
});
