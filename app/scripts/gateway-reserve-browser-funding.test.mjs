import test from "node:test";
import assert from "node:assert/strict";
import { encodePacked, encodeEventTopics, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createGatewayBrowserFunding } from "./gateway-reserve-browser-funding.mjs";
import { createGatewayBrowserJournal, gatewayMintConfirmed } from "./gateway-reserve-browser-journal.mjs";
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
    getTransaction: async ({ hash: h }) => ({
      hash: h,
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
    storage,
    locks,
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
  x.client.getTransaction = async ({ hash: h }) => ({
    hash: h,
    from: signer.address,
    to: g.minter,
    input: x.state.tx.data,
    nonce: 5,
    value: 0n,
  });
  x.options.clients[1].getTransaction = x.client.getTransaction;
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


test("replacement mint hash recovers and archives while the dropped original stays recorded", async () => {
  const x = fixture();
  await x.engine.authorize(await x.engine.quote("100000"));
  const originalReceipt = x.client.getTransactionReceipt;
  const replacement = "0x" + "ef".repeat(32);
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === hash) throw Error("original dropped");
    return originalReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  await assert.rejects(x.engine.mint(), /original dropped/);
  assert.equal(x.journal.load().steps.mint.response.hash, hash);
  const result = await x.engine.recover(replacement);
  assert.equal(result.evidence.hash, replacement);
  assert.equal(x.journal.load().steps.mint.response.hash, hash);
  await x.engine.archive();
  assert.equal(x.journal.load(), null);
  assert.equal(x.state.sends, 1);
  assert.equal(x.state.posts, 1);
});

test("replacement hash with changed calldata is rejected without resending", async () => {
  // When no original response hash was recorded (loseMint threw after send),
  // any supplied hash is treated as the putative original and checked against
  // the full saved request identity including calldata and nonce. Wrong calldata
  // must be rejected as "not the saved Gateway mint transaction".
  const x = fixture();
  await x.engine.authorize(await x.engine.quote("100000"));
  x.state.loseMint = true;
  await assert.rejects(x.engine.mint());
  // state.tx is set (send ran before throw) but no response.hash in journal.
  const originalTx = x.client.getTransaction;
  // Override client-0 to return wrong calldata; client-1 is left with correct calldata.
  // observeTxBothClients will detect the mismatch (per-client check or cross-client disagree).
  x.client.getTransaction = async (args) => ({ ...await originalTx(args), input: "0x1234" });
  await assert.rejects(x.engine.recover("0x" + "ef".repeat(32)), /calldata mismatch|not the saved/);
  assert.equal(x.journal.load().steps.mint.status, "unknown");
  assert.equal(x.state.sends, 1);
});

// ── Replacement/cancellation recovery regression tests ─────────────────────
//
// Architecture: a recovery hold keeps the mint step at status:'unknown' and
// appends a {recoveryHold, ...} entry to step.reconciliations[]. The returned
// value from recover() is the step object itself (no .evidence field for holds).
// A successful replacement confirms the step with evidence:{event:'AttestationUsed'}.
//
// Helper: read the most recent reconciliation from the journal.
function lastReconciliation(x) {
  const step = x.journal.load()?.steps.mint;
  const recs = step?.reconciliations;
  assert(Array.isArray(recs) && recs.length > 0, "Expected at least one reconciliation");
  return recs[recs.length - 1];
}

// Helper: authorize, send the mint tx (hash recorded in response), but make the
// receipt lookup for the original hash fail so the step stays "unknown". This
// leaves response.hash set so replacement-path tests can call observeOriginalTx.
async function setupLostMint(x) {
  await x.engine.authorize(await x.engine.quote("100000"));
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === hash) throw Error("original receipt unavailable");
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  await assert.rejects(x.engine.mint(), /original receipt unavailable/);
  x.client.getTransactionReceipt = origReceipt;
  x.options.clients[1].getTransactionReceipt = origReceipt;
  const rec = x.journal.load();
  assert.equal(rec.steps.mint.status, "unknown");
  assert.equal(rec.steps.mint.response.hash, hash);
}

test("R01: valid replacement same-nonce speedup mint is accepted on both clients with full AttestationUsed", async () => {
  // Genuine gatewayMint replacement: correct sender, same nonce as observed
  // original, same calldata, successful receipt with AttestationUsed event.
  // Both clients agree on all fields.
  const x = fixture();
  await setupLostMint(x);
  const replacement = "0x" + "ee".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === replacement) {
      const orig = await origGetTx({ hash: hash });
      return { ...orig, hash: replacement }; // same from, to, input, nonce, value; correct hash
    }
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === replacement)
      return { ...await origReceipt({ hash: replacement }), transactionHash: replacement };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  const result = await x.engine.recover(replacement);
  // Successful replacement: step confirmed with AttestationUsed.
  assert.equal(result.status, "confirmed");
  assert.equal(result.evidence.event, "AttestationUsed");
  assert.equal(result.evidence.hash, replacement);
  // Original response.hash preserved in journal.
  assert.equal(x.journal.load().steps.mint.response.hash, hash);
  assert.equal(x.state.sends, 1);
});

test("R02: valid original transaction observed on both clients uses original hash path", async () => {
  // Supplying the exact saved response hash goes through the original-hash path,
  // which checks state.request.nonce (nonce=4 in fixture).
  const x = fixture();
  await x.engine.authorize(await x.engine.quote("100000"));
  x.state.loseMint = true;
  await assert.rejects(x.engine.mint());
  x.state.loseMint = false;
  // hash == savedHash → original path, not replacement path.
  const result = await x.engine.recover(hash);
  assert.equal(result.status, "confirmed");
  assert.equal(result.evidence.event, "AttestationUsed");
  assert.equal(result.evidence.hash, hash);
});

test("R03: finalized cancellation (same nonce, wrong to/calldata) produces recoveryHold, keeps intent and attestation", async () => {
  const x = fixture();
  await setupLostMint(x);
  const cancelHash = "0x" + "cc".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === cancelHash)
      return { hash: cancelHash, from: x.state.account, to: x.state.account, input: "0x", nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const result = await x.engine.recover(cancelHash);
  // Hold → step stays unknown, no .evidence field on step.
  assert.equal(result.status, "unknown");
  assert.equal(result.evidence, undefined);
  // Hold written to reconciliations.
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "cancellation-observed");
  assert.equal(hold.replacementNonce, "4");
  // Journal preserved: intent and attestation intact.
  const rec = x.journal.load();
  assert(rec.intent, "Intent must be preserved after cancellation");
  assert.equal(rec.steps.attestation.status, "confirmed");
  // Cannot archive.
  await assert.rejects(x.engine.archive(), /verified/);
  assert.equal(x.state.sends, 1);
});

test("R04: wrong sender on replacement produces recoveryHold wrong-sender-nonce, step stays unknown", async () => {
  const x = fixture();
  await setupLostMint(x);
  const wrongHash = "0x" + "bb".repeat(32);
  const wrongSender = "0x" + "55".repeat(20);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === wrongHash)
      return { hash: wrongHash, from: wrongSender, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const result = await x.engine.recover(wrongHash);
  assert.equal(result.status, "unknown");
  assert.equal(result.evidence, undefined);
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "wrong-sender-nonce");
  // Step stays unknown — nonce guard active.
  assert.equal(x.journal.load().steps.mint.status, "unknown");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("R05: proposed nonce differing from observed original nonce yields wrong-sender-nonce hold", async () => {
  // Proposed nonce was "4" (from wallet.request). Simulate original tx being
  // observed at nonce=5 on both clients. Replacement at nonce=4 does not match
  // observed original nonce=5 → wrong-sender-nonce hold.
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "aa".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === hash)
      return { hash: hash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 5, value: 0n };
    if (args.hash === repHash)
      return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "wrong-sender-nonce");
  assert(/nonce/.test(hold.detail), "Hold detail should mention nonce");
  // Step stays unknown; archive blocked.
  assert.equal(x.journal.load().steps.mint.status, "unknown");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("R06: conflicting original transaction observations (nonce disagreement) produce recoveryHold", async () => {
  // clients[0] sees original at nonce=4; clients[1] sees nonce=5.
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "dd".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.options.clients[0].getTransaction = async (args) => {
    if (args.hash === hash)
      return { hash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = async (args) => {
    if (args.hash === hash)
      return { hash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 5, value: 0n };
    return origGetTx(args);
  };
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "conflicting-observations");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("R07: reverted replacement produces recoveryHold replacement-reverted, attestation stays live", async () => {
  // finalizedGatewayReceipt returns a canonical receipt even when status=reverted;
  // verifyGatewayEvent asserts status=success. The reverted path in
  // checkReplacementMint is reached before verifyGatewayEvent is called.
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "ff".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === repHash)
      return { ...await origReceipt(args), status: "reverted", transactionHash: repHash };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "replacement-reverted");
  // Intent and attestation preserved.
  const rec = x.journal.load();
  assert(rec.intent, "Intent preserved after reverted replacement");
  assert.equal(rec.steps.attestation.status, "confirmed");
  await assert.rejects(x.engine.archive(), /verified/);
  assert.equal(x.state.sends, 1);
});

test("R08: wrong AttestationUsed event on valid replacement throws, does not confirm", async () => {
  // Replacement has correct identity and calldata, status=success, but the
  // AttestationUsed log carries a wrong transferSpecHash so verifyGatewayEvent
  // throws. runGatewayStep propagates the throw; step stays unknown.
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "88".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === repHash) {
      const r = await origReceipt({ hash: repHash });
      const wrongLog = {
        ...r.logs[0],
        topics: [...r.logs[0].topics.slice(0, 2), "0x" + "99".repeat(32)],
      };
      return { ...r, transactionHash: repHash, logs: [wrongLog] };
    }
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  await assert.rejects(x.engine.recover(repHash));
  assert.equal(x.journal.load().steps.mint.status, "unknown");
});

test("R09: uncertain replacement finality produces recoveryHold finality-uncertain", async () => {
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "77".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === repHash)
      return { ...await origReceipt({ hash: repHash }), blockNumber: 300n, transactionHash: repHash };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  const origGetBlock = x.client.getBlock;
  x.client.getBlock = async (args) => {
    if (args.blockNumber === 300n) return { number: 300n, hash: blockHash };
    if (args.blockTag === "finalized") return { number: 200n, hash: blockHash };
    return origGetBlock(args);
  };
  x.options.clients[1].getBlock = x.client.getBlock;
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "finality-uncertain");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("R10: repeated recovery with same cancellation hash appends bounded reconciliations, step stays unknown", async () => {
  // Each call to recover() with the same cancel hash appends a new entry to
  // step.reconciliations[]. There is no clearMintHold API. The step never
  // transitions to confirmed. The nonce guard remains active throughout.
  const x = fixture();
  await setupLostMint(x);
  const cancelHash = "0x" + "c1".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === cancelHash)
      return { hash: cancelHash, from: x.state.account, to: x.state.account, input: "0x", nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const r1 = await x.engine.recover(cancelHash);
  assert.equal(r1.status, "unknown");
  assert.equal(lastReconciliation(x).recoveryHold, "cancellation-observed");
  const recs1 = x.journal.load().steps.mint.reconciliations;
  assert.equal(recs1.length, 1);

  const r2 = await x.engine.recover(cancelHash);
  assert.equal(r2.status, "unknown");
  assert.equal(lastReconciliation(x).recoveryHold, "cancellation-observed");
  const recs2 = x.journal.load().steps.mint.reconciliations;
  assert.equal(recs2.length, 2);

  // Cannot archive; step stays unknown.
  await assert.rejects(x.engine.archive(), /verified/);
  assert.equal(x.state.sends, 1);
  // Original request, response, intent and attestation all preserved.
  const rec = x.journal.load();
  assert.equal(rec.steps.mint.response.hash, hash);
  assert.deepEqual(rec.steps.mint.request, x.journal.load().steps.mint.request);
  assert(rec.intent, "Intent retained after repeated cancellation recovery");
  assert.equal(rec.steps.attestation.status, "confirmed");
});

test("R11: cancellation does not allow archive, reset, or fresh authorization", async () => {
  const x = fixture();
  await setupLostMint(x);
  const cancelHash = "0x" + "c2".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === cancelHash)
      return { hash: cancelHash, from: x.state.account, to: x.state.account, input: "0x", nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const result = await x.engine.recover(cancelHash);
  assert.equal(result.status, "unknown");
  // archiveMint must reject – step is not a confirmed AttestationUsed.
  await assert.rejects(x.journal.archiveMint(), /verified/);
  // retryUnsentMint must reject – step is unknown, not an unsent-mint confirmation.
  await assert.rejects(x.journal.retryUnsentMint(), /uncertain/);
  // quote() with an active record returns the cached plan; does not start fresh.
  const plan = await x.engine.quote("50000");
  assert.equal(plan.intent.spec.value, "100000");
  // Original intent preserved.
  const rec = x.journal.load();
  assert(rec.intent, "Intent must be retained after cancellation recovery");
  assert.equal(rec.intent.spec.value, "100000");
  assert.equal(rec.steps.attestation.status, "confirmed");
});

test("R12: confirmed successful mint is not overwritten by a subsequent recovery call", async () => {
  // After a successful mint (step confirmed, evidence=AttestationUsed),
  // recover() with any suppliedHash returns the already-confirmed step immediately.
  // runGatewayStep returns prior unchanged when prior.status==='confirmed'.
  const x = fixture();
  await x.engine.authorize(await x.engine.quote("100000"));
  const mintResult = await x.engine.mint();
  assert.equal(mintResult.evidence.event, "AttestationUsed");
  const confirmedEvidence = x.journal.load().steps.mint.evidence;
  const anyHash = "0x" + "91".repeat(32);
  const result = await x.engine.recover(anyHash);
  assert.equal(result.status, "confirmed");
  assert.equal(result.evidence.event, "AttestationUsed");
  assert.deepEqual(result.evidence, confirmedEvidence);
  assert.equal(x.state.sends, 1);
});

// ── Additional coverage cases ───────────────────────────────────────────────

test("R13: conflicting original tx identities across peers (calldata mismatch) produce recoveryHold", async () => {
  // clients[0] sees original calldata correctly; clients[1] sees different input.
  // observeTxBothClients should detect the disagreement and return
  // conflicting-observations even before the replacement is classified.
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "13".repeat(32);
  x.options.clients[0].getTransaction = async (args) => {
    return { hash: args.hash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
  };
  x.options.clients[1].getTransaction = async (args) => {
    if (args.hash === hash)
      return { hash: hash, from: x.state.account, to: g.minter, input: "0xdeadbeef", nonce: 4, value: 0n };
    return { hash: args.hash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
  };
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "conflicting-observations");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("R14: replacement peers differing in calldata produce conflicting-observations hold", async () => {
  // clients[0] and clients[1] agree on the original tx but disagree on the
  // replacement's calldata. The disagreement should produce a hold.
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "14".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.options.clients[0].getTransaction = async (args) => {
    if (args.hash === hash) return { hash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    if (args.hash === repHash) return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = async (args) => {
    if (args.hash === hash) return { hash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    if (args.hash === repHash) return { hash: repHash, from: x.state.account, to: g.minter, input: "0xdifferent", nonce: 4, value: 0n };
    return origGetTx(args);
  };
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "conflicting-observations");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("R15: replacement with nonzero native value but otherwise correct identity produces cancellation-observed hold", async () => {
  // Same sender, same nonce, correct calldata, but value != 0n.
  // isMintCall requires value === 0n, so this is treated as a non-mint tx.
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "15".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 1n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "cancellation-observed");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("R16: unfinalized cancellation remains held, does not release nonce guard", async () => {
  // Same as R03 but the cancellation block is not yet finalized.
  // The hold must be finality-uncertain, not cancellation-observed.
  const x = fixture();
  await setupLostMint(x);
  const cancelHash = "0x" + "16".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === cancelHash)
      return { hash: cancelHash, from: x.state.account, to: x.state.account, input: "0x", nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === cancelHash)
      return { ...await origReceipt(args), blockNumber: 500n, transactionHash: cancelHash };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  const origGetBlock = x.client.getBlock;
  x.client.getBlock = async (args) => {
    if (args.blockNumber === 500n) return { number: 500n, hash: blockHash };
    if (args.blockTag === "finalized") return { number: 200n, hash: blockHash };
    return origGetBlock(args);
  };
  x.options.clients[1].getBlock = x.client.getBlock;
  const result = await x.engine.recover(cancelHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "finality-uncertain");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("R17: successful replacement can be rechecked and archived after journal reload", async () => {
  // Confirms that a replacement-confirmed step survives serialization and
  // that archive works correctly on a reloaded engine.
  const x = fixture();
  await setupLostMint(x);
  const replacement = "0x" + "17".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === replacement) return { ...await origGetTx({ hash: hash }), hash: replacement };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === replacement)
      return { ...await origReceipt({ hash: replacement }), transactionHash: replacement };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  const result = await x.engine.recover(replacement);
  assert.equal(result.status, "confirmed");
  assert.equal(result.evidence.hash, replacement);
  // Simulate reload by creating a new engine with the same options/storage.
  const reloaded = createGatewayBrowserFunding(x.options);
  const rec = reloaded.load();
  assert.equal(rec.steps.mint.status, "confirmed");
  assert.equal(rec.steps.mint.evidence.hash, replacement);
  // Archive succeeds on the reloaded engine.
  await reloaded.archive();
  assert.equal(reloaded.load(), null);
});

test("R18: a different supplied hash does not clear a previous uncertainty or permit new authorization", async () => {
  // After a cancellation hold is recorded, supplying a different hash appends
  // another entry; the original response.hash, request, intent and attestation
  // all remain unchanged. No clearMintHold API is exposed.
  const x = fixture();
  await setupLostMint(x);
  const cancelHash1 = "0x" + "18".repeat(32);
  const cancelHash2 = "0x" + "19".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === cancelHash1 || args.hash === cancelHash2)
      return { hash: args.hash, from: x.state.account, to: x.state.account, input: "0x", nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  // First cancellation.
  const r1 = await x.engine.recover(cancelHash1);
  assert.equal(r1.status, "unknown");
  const recs1 = x.journal.load().steps.mint.reconciliations;
  assert.equal(recs1.length, 1);
  assert.equal(recs1[0].recoveryHold, "cancellation-observed");
  // Second, different cancellation hash.
  const r2 = await x.engine.recover(cancelHash2);
  assert.equal(r2.status, "unknown");
  const recs2 = x.journal.load().steps.mint.reconciliations;
  assert.equal(recs2.length, 2);
  assert.equal(recs2[1].recoveryHold, "cancellation-observed");
  // Original response.hash unchanged.
  assert.equal(x.journal.load().steps.mint.response.hash, hash);
  // Cannot archive; cannot begin a new authorization.
  await assert.rejects(x.engine.archive(), /verified/);
  await assert.rejects(x.journal.archiveMint(), /verified/);
  // No clearMintHold API exists.
  assert.equal(typeof x.journal.clearMintHold, "undefined");
});

// ── P1a: originalIdentity persistence and archive safety ────────────────────

test("P1a-1: archive after replacement succeeds even when both RPCs refuse the original hash", async () => {
  // Confirms replacement, reloads engine, makes BOTH RPCs refuse getTransaction
  // for the original hash, then successfully rechecks and archives the
  // replacement without sending anything new. The saved evidence.originalIdentity
  // is used instead of a live query.
  const x = fixture();
  await setupLostMint(x);
  const replacement = "0x" + "1a".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === replacement)
      return { hash: replacement, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === replacement)
      return { ...await origReceipt({ hash: replacement }), transactionHash: replacement };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  // Confirm the replacement.
  const result = await x.engine.recover(replacement);
  assert.equal(result.status, "confirmed");
  assert.equal(result.evidence.event, "AttestationUsed");
  assert.equal(result.evidence.hash, replacement);
  // originalIdentity must be saved in evidence.
  const saved = result.evidence.originalIdentity;
  assert(saved, "evidence.originalIdentity must be persisted");
  assert.equal(saved.originalHash.toLowerCase(), hash.toLowerCase());
  assert.equal(saved.from.toLowerCase(), x.state.account.toLowerCase());
  assert.equal(saved.nonce, "4");
  // Reload the engine and make BOTH peers refuse the original hash.
  const reloaded = createGatewayBrowserFunding(x.options);
  x.options.clients[0].getTransaction = async (args) => {
    if (args.hash === hash) throw Error("original tx evicted");
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = async (args) => {
    if (args.hash === hash) throw Error("original tx evicted");
    if (args.hash === replacement)
      return { hash: replacement, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  // Archive must succeed using saved originalIdentity; no new sends.
  await reloaded.archive();
  assert.equal(reloaded.load(), null);
  assert.equal(x.state.sends, 1);
});

test("P1a-2: changed or incomplete saved original identity prevents archive", async () => {
  const x = fixture();
  await setupLostMint(x);
  const replacement = "0x" + "1b".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === replacement)
      return { hash: replacement, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === replacement)
      return { ...await origReceipt({ hash: replacement }), transactionHash: replacement };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  await x.engine.recover(replacement);
  // Mutated durable observations must never suffice to release the guard.
  const rec = x.journal.load();
  for (const [field, value] of [
    ["from", "0x" + "aa".repeat(20)],
    ["to", "0x" + "aa".repeat(20)],
    ["input", "0xdead"],
    ["value", "1"],
    ["value", undefined],
    ["originalHash", "0x" + "aa".repeat(32)],
  ]) {
    const changed = structuredClone(rec);
    changed.steps.mint.evidence.originalIdentity[field] = value;
    x.storage.setItem(x.journal.key, JSON.stringify(changed));
    await assert.rejects(x.engine.archive(), /saved original identity|original.*request|verifiable original/i);
  }
  assert.equal(x.state.sends, 1);
});

test("P1a-3: tampered saved originalIdentity (wrong nonce) prevents archive", async () => {
  // Confirm replacement, then tamper the saved nonce. Archive must reject.
  const x = fixture();
  await setupLostMint(x);
  const replacement = "0x" + "1c".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === replacement)
      return { hash: replacement, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === replacement)
      return { ...await origReceipt({ hash: replacement }), transactionHash: replacement };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  await x.engine.recover(replacement);
  // Tamper: overwrite nonce in storage.
  const rec = x.journal.load();
  rec.steps.mint.evidence.originalIdentity.nonce = "99";
  x.storage.setItem(x.journal.key, JSON.stringify(rec));
  // revalidateForArchive: repIdentity.nonce ("4") !== savedOriginal.nonce ("99").
  await assert.rejects(x.engine.archive(), /nonce/i);
  assert.equal(x.state.sends, 1);
});

test("P1a-4: legacy confirmed replacement without originalIdentity cannot archive", async () => {
  // Simulate a legacy confirmed replacement step (from before this fix) that
  // is missing evidence.originalIdentity. Archive must refuse rather than
  // silently proceed without verifying the original.
  const x = fixture();
  await setupLostMint(x);
  const replacement = "0x" + "1d".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === replacement)
      return { hash: replacement, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  x.client.getTransactionReceipt = async (args) => {
    if (args.hash === replacement)
      return { ...await origReceipt({ hash: replacement }), transactionHash: replacement };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = x.client.getTransactionReceipt;
  await x.engine.recover(replacement);
  // Remove originalIdentity from evidence to simulate a legacy step.
  const rec = x.journal.load();
  delete rec.steps.mint.evidence.originalIdentity;
  x.storage.setItem(x.journal.key, JSON.stringify(rec));
  await assert.rejects(x.engine.archive(), /missing a verifiable original observation/i);
  assert.equal(x.state.sends, 1);
});

// ── P1b: tx.hash binding in observeTxBothClients ───────────────────────────

test("P1b-1: client-0 returns wrong tx.hash for original request produces conflicting-observations hold", async () => {
  // client-0 returns a tx whose hash does not match the requested original hash.
  // All other fields (from, to, input, nonce, value) are correct.
  // The hash-binding check must catch this before the cross-client comparison.
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "1e".repeat(32);
  const wrongOrigHash = "0x" + "de".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.options.clients[0].getTransaction = async (args) => {
    if (args.hash === hash)
      // Return the correct tx data but with the wrong hash field.
      return { hash: wrongOrigHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  // client-1 returns the correct hash.
  x.options.clients[1].getTransaction = async (args) => origGetTx(args);
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "conflicting-observations");
  assert(/hash/.test(hold.detail), "Hold detail should mention hash mismatch");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("P1b-2: client-1 returns wrong tx.hash for original request produces conflicting-observations hold", async () => {
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "1f".repeat(32);
  const wrongOrigHash = "0x" + "ef".repeat(32);
  const origGetTx = x.client.getTransaction;
  // client-0 correct; client-1 returns wrong hash for original.
  x.options.clients[0].getTransaction = async (args) => origGetTx(args);
  x.options.clients[1].getTransaction = async (args) => {
    if (args.hash === hash)
      return { hash: wrongOrigHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "conflicting-observations");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("P1b-3: client-0 returns wrong tx.hash for replacement request produces conflicting-observations hold", async () => {
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "b0".repeat(32);
  const wrongRepHash = "0x" + "b1".repeat(32);
  const origGetTx = x.client.getTransaction;
  // Original is correct on both clients.
  // client-0 returns wrong hash for the replacement.
  x.options.clients[0].getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: wrongRepHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "conflicting-observations");
  await assert.rejects(x.engine.archive(), /verified/);
});

test("P1b-4: client-1 returns wrong tx.hash for replacement request produces conflicting-observations hold", async () => {
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "b2".repeat(32);
  const wrongRepHash = "0x" + "b3".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.options.clients[0].getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: wrongRepHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.equal(hold.recoveryHold, "conflicting-observations");
  await assert.rejects(x.engine.archive(), /verified/);
});

// ── P2: receipt.transactionHash binding in finalizedGatewayReceipt ──────────

test("P2-1: receipt with wrong transactionHash on client-0 for cancellation produces hold, not cancellation-observed", async () => {
  // finalizedGatewayReceipt now validates receipt.transactionHash on each client.
  // A receipt whose transactionHash differs from the requested hash must not be
  // classified as a finalized cancellation; it must remain unresolved.
  const x = fixture();
  await setupLostMint(x);
  const cancelHash = "0x" + "c3".repeat(32);
  const staleHash  = "0x" + "c4".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === cancelHash)
      return { hash: cancelHash, from: x.state.account, to: x.state.account, input: "0x", nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  // client-0 returns a receipt with a stale/wrong transactionHash.
  x.options.clients[0].getTransactionReceipt = async (args) => {
    if (args.hash === cancelHash)
      return { ...await origReceipt({ hash: cancelHash }), transactionHash: staleHash };
    return origReceipt(args);
  };
  // client-1 returns a receipt with the correct transactionHash.
  x.options.clients[1].getTransactionReceipt = async (args) => {
    if (args.hash === cancelHash)
      return { ...await origReceipt({ hash: cancelHash }), transactionHash: cancelHash };
    return origReceipt(args);
  };
  const result = await x.engine.recover(cancelHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  // Must NOT be cancellation-observed; must be conflicting-observations or finality-uncertain.
  assert.notEqual(hold.recoveryHold, "cancellation-observed",
    "A wrong-hash receipt must not be classified as finalized cancellation");
  assert(/conflicting|uncertain/.test(hold.recoveryHold));
  await assert.rejects(x.engine.archive(), /verified/);
});

test("P2-2: receipt with wrong transactionHash on client-1 for reverted replacement produces hold, not replacement-reverted", async () => {
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "c5".repeat(32);
  const staleHash = "0x" + "c6".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  // client-0 returns the correct hash; client-1 returns the wrong hash.
  x.options.clients[0].getTransactionReceipt = async (args) => {
    if (args.hash === repHash)
      return { ...await origReceipt({ hash: repHash }), transactionHash: repHash, status: "reverted" };
    return origReceipt(args);
  };
  x.options.clients[1].getTransactionReceipt = async (args) => {
    if (args.hash === repHash)
      return { ...await origReceipt({ hash: repHash }), transactionHash: staleHash, status: "reverted" };
    return origReceipt(args);
  };
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert.notEqual(hold.recoveryHold, "replacement-reverted",
    "A wrong-hash receipt must not be classified as finalized revert");
  assert(/conflicting|uncertain/.test(hold.recoveryHold));
  await assert.rejects(x.engine.archive(), /verified/);
});

test("P2-3: receipt missing transactionHash entirely remains unresolved for both peers", async () => {
  // Both clients return a receipt without a transactionHash field.
  // This should not be classified as any finalized outcome.
  const x = fixture();
  await setupLostMint(x);
  const repHash = "0x" + "c7".repeat(32);
  const origGetTx = x.client.getTransaction;
  x.client.getTransaction = async (args) => {
    if (args.hash === repHash)
      return { hash: repHash, from: x.state.account, to: g.minter, input: x.state.tx.data, nonce: 4, value: 0n };
    return origGetTx(args);
  };
  x.options.clients[1].getTransaction = x.client.getTransaction;
  const origReceipt = x.client.getTransactionReceipt;
  const receiptWithoutHash = async (args) => {
    const r = await origReceipt(args);
    const { transactionHash: _, ...rest } = r;
    return rest; // no transactionHash field
  };
  x.options.clients[0].getTransactionReceipt = receiptWithoutHash;
  x.options.clients[1].getTransactionReceipt = receiptWithoutHash;
  const result = await x.engine.recover(repHash);
  assert.equal(result.status, "unknown");
  const hold = lastReconciliation(x);
  assert(/conflicting|uncertain/.test(hold.recoveryHold),
    `Expected conflicting or uncertain, got ${hold.recoveryHold}`);
  await assert.rejects(x.engine.archive(), /verified/);
});

test("account guard blocks unresolved Gateway state independently of funding route or feature flag", async () => {
  const { assertGatewayFundingResolved, gatewayWalletLockKey } = await import("../src/gatewayFundingGuard.ts");
  const x = fixture();
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "localStorage", {configurable:true,value:x.storage});
  Object.defineProperty(globalThis, "navigator", {configurable:true,value:{locks:x.locks}});
  try {
    assert.doesNotThrow(() => assertGatewayFundingResolved(signer.address));
    await x.engine.authorize(await x.engine.quote("100000"));
    assert.throws(() => assertGatewayFundingResolved(signer.address), /Resolve the Gateway/);
    assert.throws(() => assertGatewayFundingResolved(signer.address.toLowerCase()), /Resolve the Gateway/);
    assert.equal(gatewayWalletLockKey(signer.address), gatewayWalletLockKey(signer.address.toLowerCase()));
    await x.engine.mint();
    assert.doesNotThrow(() => assertGatewayFundingResolved(signer.address));
  } finally {
    if(savedStorage) Object.defineProperty(globalThis,"localStorage",savedStorage); else delete globalThis.localStorage;
    if(savedNavigator) Object.defineProperty(globalThis,"navigator",savedNavigator); else delete globalThis.navigator;
  }
});


test("pending transactions from legacy or current deployments block new wallet actions after the lock releases", async () => {
  const { assertCandidateFundingResolved } = await import("../src/gatewayFundingGuard.ts");
  const records = new Map();
  const storage = { get length() {return records.size}, key: i => [...records.keys()][i] ?? null };
  const legacy = `shadow:candidate-funding:v1:5042002:0x1111111111111111111111111111111111111111:${signer.address.toLowerCase()}`;
  const current = legacy.replace("0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222");
  assert.doesNotThrow(() => assertCandidateFundingResolved(signer.address, storage));
  records.set(legacy, "unreadable record still holds the nonce");
  assert.throws(() => assertCandidateFundingResolved(signer.address, storage), /original funding page/);
  records.delete(legacy);
  records.set(current, "pending");
  assert.throws(() => assertCandidateFundingResolved(signer.address, storage), /original funding page/);
  assert.doesNotThrow(() => assertCandidateFundingResolved("0x" + "33".repeat(20), storage));
  records.delete(current);
  assert.doesNotThrow(() => assertCandidateFundingResolved(signer.address, storage));
});


test("incomplete or contradictory saved mint evidence never releases the account guard or permits archive", async () => {
  const { assertGatewayFundingResolved } = await import("../src/gatewayFundingGuard.ts");
  const x = fixture();
  await x.engine.authorize(await x.engine.quote("100000"));
  await x.engine.mint();
  const good = x.journal.load();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "localStorage", {configurable:true,value:x.storage});
  Object.defineProperty(globalThis, "navigator", {configurable:true,value:{locks:x.locks}});
  try {
    assert.equal(gatewayMintConfirmed(good.steps.mint), true);
    for (const corrupt of [
      step => { step.status = "unknown"; },
      step => { delete step.evidence.hash; },
      step => { step.evidence.hash = "0x1234"; },
      step => { delete step.evidence.blockHash; },
      step => { step.evidence.blockHash = "garbage"; },
      step => { delete step.evidence.blockNumber; },
      step => { step.evidence.blockNumber = "-1"; },
      step => { step.evidence.notSubmitted = true; },
      step => { step.response.notSubmitted = true; },
    ]) {
      const bad = structuredClone(good);
      corrupt(bad.steps.mint);
      x.storage.setItem(x.journal.key, JSON.stringify(bad));
      assert.equal(gatewayMintConfirmed(x.journal.load().steps.mint), false);
      assert.throws(() => assertGatewayFundingResolved(signer.address), /Resolve the Gateway/);
      await assert.rejects(x.journal.archiveMint(), /verified Gateway/);
    }
    x.storage.setItem(x.journal.key, JSON.stringify(good));
    assert.doesNotThrow(() => assertGatewayFundingResolved(signer.address));
  } finally {
    if(originalStorage) Object.defineProperty(globalThis,"localStorage",originalStorage); else delete globalThis.localStorage;
    if(originalNavigator) Object.defineProperty(globalThis,"navigator",originalNavigator); else delete globalThis.navigator;
  }
});
