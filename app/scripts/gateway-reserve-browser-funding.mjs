import {
  encodeFunctionData,
  pad,
  parseUnits,
  recoverTypedDataAddress,
} from "viem";
import { gatewayAssert as assert } from "./gateway-reserve-assert.mjs";
import {
  GATEWAY_TESTNET as g,
  gatewayAbi,
  gatewayRead,
  makeGatewayIntent,
  validateGatewayIntent,
  gatewayTypedData,
  runGatewayStep,
  validateGatewayAttestation,
  finalizedGatewayReceipt,
  verifyGatewayEvent,
} from "./gateway-reserve.mjs";
import { gatewayMintConfirmed } from "./gateway-reserve-browser-journal.mjs";

// ── Recovery outcome kinds ────────────────────────────────────────────────────
//
// A successful mint produces:
//   { event: "AttestationUsed", hash, blockNumber, blockHash }
//   — the only evidence that gatewayMintConfirmed accepts; the only path that
//     permits archive.
//
// A recovery hold is appended to step.reconciliations[] (a bounded array on
// the unknown step). The step stays status:'unknown' so the wallet nonce guard
// remains live and runGatewayStep does not mark the step confirmed.
//
//   { recoveryHold: "cancellation-observed", replacementHash, replacementNonce,
//     replacementBlockHash, replacementBlockNumber }
//       A finalized tx at the same sender/nonce did NOT call gatewayMint.
//       Both clients agreed on a canonical finalized receipt. The attestation's
//       consumed/expired/revoked status is unknown. Keep original intent and
//       attestation; safe no-submission retries remain available.
//
//   { recoveryHold: "replacement-reverted", replacementHash,
//     replacementBlockHash, replacementBlockNumber }
//       A finalized replacement with correct identity and calldata finalized
//       with status "reverted". Attestation may still be live.
//
//   { recoveryHold: "wrong-sender-nonce", replacementHash, detail }
//       Replacement sender or observed nonce mismatches observed original.
//       Proposed/saved nonce NOT used for this comparison.
//
//   { recoveryHold: "conflicting-observations", replacementHash, detail }
//       Two independent clients disagree on any field of original or
//       replacement transaction (hash, from, to, input, value, nonce).
//
//   { recoveryHold: "finality-uncertain", replacementHash, detail }
//       Replacement block not yet behind finalized head on at least one client,
//       or one client couldn't confirm finality. Do not accept unfinalized state.
//
// A hold is returned from checkReplacementMint and written into
// step.reconciliations[] by appendReconciliation; checkMint then returns null
// so runGatewayStep leaves the step unknown.

const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
// Maximum reconciliation entries kept per step.
const MAX_RECONCILIATIONS = 20;

// Existing Gateway balance -> sponsor wallet. The existing Shadow funding
// review remains responsible for allowance and reserve opening afterwards.
export function createGatewayBrowserFunding({
  account,
  wallet,
  clients,
  journal,
  read = gatewayRead,
  fetchImpl = fetch,
}) {
  async function identity() {
    assert.equal(clients.length, 2, "Two independent Arc readers are required");
    for (const client of clients) {
      assert.equal(
        await client.getChainId(),
        g.chainId,
        "Arc testnet required",
      );
      for (const address of [g.wallet, g.minter]) {
        assert(
          (await client.getCode({ address }))?.length > 2,
          "Gateway contract is unavailable",
        );
        assert.equal(
          await client.readContract({
            address,
            abi: gatewayAbi,
            functionName: "domain",
          }),
          g.domain,
          "Gateway domain mismatch",
        );
      }
    }
    assert.equal(
      await wallet.getChainId(),
      g.chainId,
      "Switch your wallet to Arc testnet",
    );
    assert(
      same((await wallet.getAddresses())[0], account),
      "The selected wallet changed; reconnect it",
    );
    const code = await clients[0].getCode({ address: account });
    assert(
      !code || code === "0x",
      "This funding route currently requires a browser EOA wallet",
    );
  }
  function load() {
    return journal.load();
  }
  async function quote(amount) {
    await identity();
    const existing = load();
    if (existing)
      return { intent: existing.intent, operation: existing.operation };
    const info = (await read("/info")).domains?.find(
      (x) => x.domain === g.domain,
    );
    assert(
      info &&
        same(info.walletContract?.address, g.wallet) &&
        same(info.minterContract?.address, g.minter),
      "Gateway service configuration differs",
    );
    const initial = makeGatewayIntent({
      sponsor: account,
      amount,
      maxFee: "0",
      maxBlockHeight: info.burnIntentExpirationHeight,
    });
    const estimate = (await read("/estimate", [initial]))?.[0]?.burnIntent;
    assert(estimate, "Gateway fee estimate is unavailable");
    const intent = makeGatewayIntent({
      sponsor: account,
      amount,
      maxFee: estimate.maxFee,
      maxBlockHeight: estimate.maxBlockHeight,
      salt: initial.spec.salt,
    });
    // Gateway's JSON response may shorten EVM bytes32 address fields to 20
    // bytes. Normalize only those fields; reject all semantic route changes.
    const canonical = { ...estimate, spec: { ...estimate.spec } };
    for (const key of [
      "sourceContract",
      "destinationContract",
      "sourceToken",
      "destinationToken",
      "sourceDepositor",
      "destinationRecipient",
      "sourceSigner",
      "destinationCaller",
    ]) {
      assert.match(
        canonical.spec[key],
        /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/,
        "Invalid estimated Gateway address",
      );
      canonical.spec[key] = pad(canonical.spec[key].toLowerCase(), {
        size: 32,
      });
    }
    assert.deepEqual(
      canonical,
      intent,
      "Gateway changed more than the quoted fee and expiry",
    );
    const available = (
      await read("/balances", {
        token: "USDC",
        sources: [{ domain: g.domain, depositor: account }],
      })
    ).balances?.find((x) => x.domain === g.domain);
    assert(
      available &&
        same(available.depositor, account) &&
        typeof available.balance === "string" &&
        /^\d+(\.\d{1,6})?$/.test(available.balance),
      "Gateway balance is unavailable",
    );
    assert(
      parseUnits(available.balance, 6) >=
        BigInt(amount) + BigInt(intent.maxFee),
      "Not enough available Arc testnet Gateway USDC, including the quoted fee. Direct wallet funding is still available.",
    );
    return { intent, operation: validateGatewayIntent(intent, account) };
  }
  async function authorize(plan) {
    await identity();
    assert.equal(
      validateGatewayIntent(plan.intent, account),
      plan.operation,
      "Funding quote changed",
    );
    // Signing alone does not submit an API request. Persist the exact signed
    // request before POST. A lost signature can safely be signed again for the
    // same intent; a lost POST must never be repeated by this controller.
    const record = await journal.begin(plan.intent);
    const prior = record.steps.attestation;
    let request = prior?.request;
    if (!request) {
      const signature = await wallet.signTypedData({
        ...gatewayTypedData(record.intent),
        account,
      });
      assert(
        same(
          await recoverTypedDataAddress({
            ...gatewayTypedData(record.intent),
            signature,
          }),
          account,
        ),
        "Signature does not belong to this sponsor",
      );
      request = { burnIntent: record.intent, signature };
    }
    await identity();
    return runGatewayStep({
      sponsor: account,
      journal,
      operation: record.operation,
      phase: "attestation",
      request,
      send: async (body) => {
        const response = await fetchImpl(g.api + "/transfer", {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([body]),
          signal: AbortSignal.timeout(20000),
        });
        assert(
          response.ok,
          "Gateway response is uncertain. Keep this operation and check its status; do not create another.",
        );
        return response.json();
      },
      reconcile: (state) => checkAttestation(state, record),
    });
  }
  async function checkAttestation(state, record) {
    if (!state.response) return null;
    validateGatewayAttestation(
      state.response.attestation,
      record.intent,
      account,
      await clients[0].getBlockNumber(),
    );
    assert.match(
      state.response.signature,
      /^0x(?:[0-9a-fA-F]{2})+$/,
      "Invalid Gateway attestation signature",
    );
    return { transferSpecHash: record.operation };
  }

  // ── Two-client canonical tx observation ──────────────────────────────────
  //
  // Fetch tx from BOTH clients independently. Validate all canonical fields
  // (from, to, input, value, nonce) on BOTH observations, then assert both
  // clients agree on every field. Returns the agreed canonical identity.
  // Throws if either client fails, or if they disagree on any field.
  //
  // expectedCalldata / expectedValue / expectedTo are checked when provided,
  // giving a hard mismatch error before any cross-client comparison.
  async function observeTxBothClients(txHash, { expectedFrom, expectedTo, expectedInput, expectedValue } = {}) {
    const [tx0, tx1] = await Promise.all([
      clients[0].getTransaction({ hash: txHash }),
      clients[1].getTransaction({ hash: txHash }),
    ]);
    // Validate each observation independently: hash binding and saved expectations.
    for (const [tx, label] of [[tx0, "client-0"], [tx1, "client-1"]]) {
      // Each client must return the exact hash that was requested.
      assert(
        typeof tx?.hash === "string" && same(tx.hash, txHash),
        `${label}: returned transaction hash does not match requested hash ${txHash}`,
      );
      if (expectedFrom !== undefined)
        assert(same(tx.from, expectedFrom),
          `${label}: transaction sender mismatch for ${txHash}`);
      if (expectedTo !== undefined)
        assert(same(tx.to, expectedTo),
          `${label}: transaction destination mismatch for ${txHash}`);
      if (expectedInput !== undefined)
        assert(tx.input === expectedInput,
          `${label}: transaction calldata mismatch for ${txHash}`);
      if (expectedValue !== undefined)
        assert(tx.value === expectedValue,
          `${label}: transaction value mismatch for ${txHash}`);
    }
    // Assert both clients agree on every canonical field including the hash.
    assert(
      same(tx0.hash, tx1.hash) &&
      same(tx0.from, tx1.from) &&
      same(tx0.to, tx1.to) &&
      tx0.input === tx1.input &&
      tx0.value === tx1.value &&
      String(tx0.nonce) === String(tx1.nonce),
      `Independent clients disagree on transaction ${txHash} (hash/from/to/input/value/nonce)`,
    );
    return {
      from: tx0.from.toLowerCase(),
      to: tx0.to?.toLowerCase() ?? null,
      input: tx0.input,
      value: tx0.value,
      nonce: String(tx0.nonce),
    };
  }

  // Establish the canonical original transaction identity using both clients.
  // Validates that the original was a gatewayMint call from this account with
  // the saved calldata. Returns { from, nonce } for replacement comparison.
  // Saved proposed nonce (state.request.nonce) is NOT used here.
  async function observeOriginalTx(state) {
    const originalHash = state.response?.hash;
    assert.match(
      originalHash,
      hashPattern,
      "Original transaction hash is not recorded; cannot establish canonical identity",
    );
    return observeTxBothClients(originalHash, {
      expectedFrom: account,
      expectedTo: g.minter,
      expectedInput: state.request.data,
      expectedValue: 0n,
    });
  }

  // ── Shared canonical finality verifier ───────────────────────────────────
  //
  // Wraps finalizedGatewayReceipt; translates its assertion errors into
  // structured hold kinds while preserving the underlying failure detail. Returns { receipt, hold } where hold is null on success or
  // a recoveryHold object describing why the receipt could not be accepted.
  // Does NOT assert receipt.status — supports both success and reverted.
  async function getCanonicalFinalizedReceipt(txHash, replacementHash) {
    try {
      const receipt = await finalizedGatewayReceipt(clients, txHash);
      return { receipt, hold: null };
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (/not finalized/i.test(msg)) {
        return {
          receipt: null,
          hold: { recoveryHold: "finality-uncertain", replacementHash, detail: msg },
        };
      }
      // Noncanonical block, RPC disagreement on logs/status, unavailable receipt.
      return {
        receipt: null,
        hold: { recoveryHold: "conflicting-observations", replacementHash, detail: msg },
      };
    }
  }

  // ── Replacement / cancellation check ─────────────────────────────────────
  //
  // Returns a recoveryHold object (hold) or a confirmed AttestationUsed
  // evidence object (success). Never returns null.
  //
  // On success, the returned evidence includes originalIdentity so that
  // archive can validate the replacement nonce without re-querying the
  // (possibly evicted) original transaction.
  async function checkReplacementMint(state, record, suppliedHash) {
    // Step 1: establish canonical original tx identity from both clients.
    // Validates from/to/input/value on both clients and asserts agreement.
    // Also validates that each client's returned hash matches the requested hash.
    let originalIdentity;
    try {
      originalIdentity = await observeOriginalTx(state);
    } catch (err) {
      return {
        recoveryHold: "conflicting-observations",
        replacementHash: suppliedHash,
        detail: String(err?.message ?? err),
      };
    }

    // Step 2: fetch and fully validate the replacement tx from both clients.
    // Check that both clients return the exact requested hash and agree on all fields.
    let repIdentity;
    try {
      repIdentity = await observeTxBothClients(suppliedHash);
    } catch (err) {
      return {
        recoveryHold: "conflicting-observations",
        replacementHash: suppliedHash,
        detail: `Replacement tx: ${String(err?.message ?? err)}`,
      };
    }

    // Step 3: replacement must come from the same sender at the same nonce as
    // the independently observed original transaction. Proposed nonce NOT used.
    if (
      !same(repIdentity.from, originalIdentity.from) ||
      repIdentity.nonce !== originalIdentity.nonce
    ) {
      return {
        recoveryHold: "wrong-sender-nonce",
        replacementHash: suppliedHash,
        detail: `Replacement from=${repIdentity.from} nonce=${repIdentity.nonce} does not match observed original from=${originalIdentity.from} nonce=${originalIdentity.nonce}`,
      };
    }

    // Step 4: classify as mint call or cancellation.
    // A mint call must address the minter with the saved calldata and value=0.
    const isMintCall =
      same(repIdentity.to, g.minter) &&
      repIdentity.input === state.request.data &&
      repIdentity.value === 0n;

    // Step 5: obtain a canonical finalized receipt from both clients for ALL
    // outcomes — cancellation AND mint call. A pending or unfinalized receipt
    // must retain uncertainty; do not classify without a canonical receipt.
    // Both receipt.transactionHash fields are now validated against suppliedHash
    // inside finalizedGatewayReceipt, so a stale or wrong-hash receipt is caught
    // before any classification.
    const { receipt, hold } = await getCanonicalFinalizedReceipt(suppliedHash, suppliedHash);
    if (hold) return hold;

    if (!isMintCall) {
      // Finalized cancellation (same nonce, not a gatewayMint call).
      // Attestation consumed/expired/revoked status is unknown.
      return {
        recoveryHold: "cancellation-observed",
        replacementHash: suppliedHash,
        replacementNonce: repIdentity.nonce,
        replacementBlockHash: receipt.blockHash,
        replacementBlockNumber: String(receipt.blockNumber),
      };
    }

    // Step 6: reverted replacement — attestation may still be live.
    if (receipt.status !== "success") {
      return {
        recoveryHold: "replacement-reverted",
        replacementHash: suppliedHash,
        replacementBlockHash: receipt.blockHash,
        replacementBlockNumber: String(receipt.blockNumber),
      };
    }

    // Step 7: successful replacement mint — full canonical verification
    // including exact AttestationUsed event and transferSpecHash.
    // verifyGatewayEvent throws (propagates to caller) on any mismatch.
    const event = verifyGatewayEvent({
      receipt,
      hash: suppliedHash,
      kind: "mint",
      intent: record.intent,
      sponsor: account,
    });

    // Persist the independently observed original identity alongside the
    // AttestationUsed evidence so that archive can verify the replacement
    // nonce without re-querying the (possibly evicted) original transaction.
    // originalIdentity carries: { from, nonce } (and implicitly the original
    // hash is state.response.hash, validated as part of observeOriginalTx).
    return {
      ...event,
      originalIdentity: {
        originalHash: state.response.hash,
        from: originalIdentity.from,
        nonce: originalIdentity.nonce,
        to: originalIdentity.to,
        input: originalIdentity.input,
        value: String(originalIdentity.value),
      },
    };
  }

  // ── Primary mint check ────────────────────────────────────────────────────
  //
  // When isReplacement: delegates to checkReplacementMint and writes any hold
  // into step.reconciliations[] via journal, then returns null so runGatewayStep
  // leaves the step unknown. Returns the AttestationUsed object on success.
  //
  // When NOT isReplacement: verifies the original submitted hash using the
  // saved canonical request identity (including nonce), unchanged.
  async function checkMint(state, record, suppliedHash) {
    if (state.response?.notSubmitted === true) return { notSubmitted: true };

    const savedHash = state.response?.hash;
    const isReplacement =
      Boolean(suppliedHash) &&
      Boolean(savedHash) &&
      suppliedHash.toLowerCase() !== savedHash.toLowerCase();

    if (isReplacement) {
      assert.match(suppliedHash, hashPattern, "Enter a valid transaction hash");
      const outcome = await checkReplacementMint(state, record, suppliedHash);
      if (outcome.recoveryHold) {
        // Append bounded hold evidence to the step without confirming it.
        await journal.appendReconciliation(record.operation, outcome);
        return null; // keep step unknown
      }
      // Successful replacement AttestationUsed — return for runGatewayStep to confirm.
      return outcome;
    }

    // Original-hash path: checks against saved canonical request identity
    // (to, data, nonce, value) using both clients. observeTxBothClients now
    // enforces that each client's returned tx.hash equals the requested hash.
    const h =
      suppliedHash ??
      (state.evidence?.event === "AttestationUsed"
        ? state.evidence.hash
        : savedHash);
    if (!h) return null;
    assert.match(h, hashPattern, "Enter the original transaction hash");
    const txIdentity = await observeTxBothClients(h, {
      expectedFrom: account,
      expectedTo: g.minter,
      expectedInput: state.request.data,
      expectedValue: 0n,
    });
    assert(
      String(txIdentity.nonce) === state.request.nonce,
      "This is not the saved Gateway mint transaction",
    );
    const receipt = await finalizedGatewayReceipt(clients, h);
    return verifyGatewayEvent({
      receipt,
      hash: h,
      kind: "mint",
      intent: record.intent,
      sponsor: account,
    });
  }

  async function mint() {
    await identity();
    let record = load();
    assert(
      record?.steps.attestation?.status === "confirmed",
      "Confirm the Gateway authorization first",
    );
    const prior = record.steps.mint;
    if (
      prior?.status === "confirmed" &&
      prior.evidence?.notSubmitted === true
    ) {
      await journal.retryUnsentMint();
      record = load();
    } else if (prior) return recover();
    const a = record.steps.attestation.response;
    validateGatewayAttestation(
      a.attestation,
      record.intent,
      account,
      await clients[0].getBlockNumber(),
    );
    const data = encodeFunctionData({
      abi: gatewayAbi,
      functionName: "gatewayMint",
      args: [a.attestation, a.signature],
    });
    await clients[0].simulateContract({
      address: g.minter,
      abi: gatewayAbi,
      functionName: "gatewayMint",
      args: [a.attestation, a.signature],
      account,
    });
    const nonceHex = await wallet.request({
      method: "eth_getTransactionCount",
      params: [account, "pending"],
    });
    assert.match(
      nonceHex,
      /^0x[0-9a-fA-F]+$/,
      "Wallet returned an invalid nonce",
    );
    const nonce = BigInt(nonceHex);
    assert(
      nonce <= BigInt(Number.MAX_SAFE_INTEGER),
      "Wallet nonce is unsupported",
    );
    const request = { to: g.minter, data, value: "0", nonce: String(nonce) };
    return runGatewayStep({
      sponsor: account,
      journal,
      operation: record.operation,
      phase: "mint",
      request,
      send: async () => {
        try {
          await identity();
          assert.equal(
            BigInt(
              await wallet.request({
                method: "eth_getTransactionCount",
                params: [account, "pending"],
              }),
            ),
            nonce,
            "Wallet nonce changed",
          );
        } catch {
          return { notSubmitted: true, reason: "wallet-preflight" };
        }
        let hash;
        try {
          hash = await wallet.sendTransaction({
            account,
            to: g.minter,
            data,
            value: 0n,
            nonce: Number(nonce),
            chain: wallet.chain,
          });
        } catch (error) {
          const visited = new Set();
          let current = error;
          while (current && !visited.has(current)) {
            visited.add(current);
            if (current.code === 4001)
              return { notSubmitted: true, reason: "wallet-rejected" };
            current = current.cause;
          }
          throw error;
        }
        assert.match(
          hash,
          hashPattern,
          "Wallet did not return a transaction hash",
        );
        return { hash };
      },
      reconcile: (state) => checkMint(state, record),
    });
  }

  async function recover(suppliedHash) {
    const record = load();
    assert(record, "No saved Gateway funding operation");
    if (record.steps.mint) {
      return runGatewayStep({
        sponsor: account,
        journal,
        operation: record.operation,
        phase: "mint",
        request: record.steps.mint.request,
        send: async () => {
          throw Error("Recovery cannot send");
        },
        reconcile: (state) => checkMint(state, record, suppliedHash),
      });
    }
    if (record.steps.attestation) {
      return runGatewayStep({
        sponsor: account,
        journal,
        operation: record.operation,
        phase: "attestation",
        request: record.steps.attestation.request,
        send: async () => {
          throw Error("Recovery cannot send");
        },
        reconcile: (state) => checkAttestation(state, record),
      });
    }
    // No API response means no attestation to mint. The source authorization may
    // still be live. Keep the original identity, even after a UI timeout.
    return {
      status: "unknown",
      message:
        "No confirmed mint yet. Keep the original Gateway operation; a missing response does not prove it failed.",
    };
  }

  // Re-verify the confirmed mint before archive. Uses the hash from confirmed
  // evidence (which may be a replacement hash).
  //
  // For replacements: uses the persisted evidence.originalIdentity rather than
  // re-querying the (possibly evicted) original transaction. A legacy confirmed
  // replacement step without a saved originalIdentity cannot be archived — it
  // is treated as a hold.
  //
  // For original-hash confirmations: verifies via both clients using
  // observeTxBothClients (which now enforces tx.hash binding) and the saved
  // request identity including nonce.
  async function revalidateForArchive(record) {
    const step = record.steps.mint;
    assert(gatewayMintConfirmed(step), "Original Gateway mint must be verified before archive");
    const evidenceHash = step.evidence.hash;
    const savedHash = step.response?.hash;
    const isReplacement =
      savedHash &&
      evidenceHash.toLowerCase() !== savedHash.toLowerCase();

    if (isReplacement) {
      // Use the originalIdentity persisted at recovery time. If it is absent
      // (a legacy confirmed step from before this fix), refuse to archive —
      // the original transaction may be evicted and cannot be reconstructed
      // safely from the journal alone.
      const savedOriginal = step.evidence.originalIdentity;
      assert(
        savedOriginal &&
          typeof savedOriginal.originalHash === "string" &&
          hashPattern.test(savedOriginal.originalHash) &&
          typeof savedOriginal.from === "string" &&
          typeof savedOriginal.nonce === "string" &&
          savedOriginal.originalHash.toLowerCase() === savedHash.toLowerCase(),
        "Confirmed replacement evidence is missing a verifiable original observation; cannot archive safely",
      );
      // Cross-check saved originalIdentity against the saved request fields.
      assert(
        same(savedOriginal.from, account) &&
          same(savedOriginal.to, g.minter) &&
          savedOriginal.input === step.request.data &&
          savedOriginal.value === "0",
        "Saved original identity does not match the saved Gateway mint request",
      );
      // Re-verify the replacement itself with both clients. This does not require
      // the original to be queryable.
      const repIdentity = await observeTxBothClients(evidenceHash, {
        expectedFrom: account,
        expectedTo: g.minter,
        expectedInput: step.request.data,
        expectedValue: 0n,
      });
      // Verify nonce match using the saved original nonce (not proposed nonce).
      assert(
        repIdentity.nonce === savedOriginal.nonce,
        "Replacement nonce does not match the saved original transaction nonce",
      );
      const receipt = await finalizedGatewayReceipt(clients, evidenceHash);
      assert.equal(receipt.status, "success", "Replacement receipt is not successful");
      const event = verifyGatewayEvent({
        receipt,
        hash: evidenceHash,
        kind: "mint",
        intent: record.intent,
        sponsor: account,
      });
      assert.equal(event?.event, "AttestationUsed", "Original Gateway mint must be verified before archive");
      return event;
    }

    // Original hash path: re-verify with the saved request identity using both
    // clients (observeTxBothClients enforces tx.hash binding on each peer).
    const txIdentity = await observeTxBothClients(evidenceHash, {
      expectedFrom: account,
      expectedTo: g.minter,
      expectedInput: step.request.data,
      expectedValue: 0n,
    });
    assert(
      String(txIdentity.nonce) === step.request.nonce,
      "This is not the saved Gateway mint transaction",
    );
    const receipt = await finalizedGatewayReceipt(clients, evidenceHash);
    return verifyGatewayEvent({
      receipt,
      hash: evidenceHash,
      kind: "mint",
      intent: record.intent,
      sponsor: account,
    });
  }

  async function archive() {
    const record = load();
    assert(record?.steps.mint, "No saved Gateway withdrawal");
    assert(
      gatewayMintConfirmed(record.steps.mint),
      "Original Gateway mint must be verified before archive",
    );
    // Live re-verify before clearing the active operation.
    const event = await revalidateForArchive(record);
    assert.equal(
      event?.event,
      "AttestationUsed",
      "Original Gateway mint must be verified before archive",
    );
    await journal.archiveMint();
  }

  return { load, quote, authorize, mint, recover, archive };
}
