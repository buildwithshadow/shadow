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
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hashPattern = /^0x[0-9a-fA-F]{64}$/;

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
  async function checkMint(state, record, suppliedHash) {
    if (state.response?.notSubmitted === true) return { notSubmitted: true };
    const hash =
      suppliedHash ??
      (state.evidence?.event === "AttestationUsed"
        ? state.evidence.hash
        : state.response?.hash);
    if (!hash) return null;
    assert.match(hash, hashPattern, "Enter the original transaction hash");
    const receipt = await finalizedGatewayReceipt(clients, hash);
    const tx = await clients[0].getTransaction({ hash });
    assert(
      same(tx.from, account) &&
        same(tx.to, g.minter) &&
        tx.input === state.request.data &&
        String(tx.nonce) === state.request.nonce &&
        tx.value === 0n,
      "This is not the saved Gateway mint transaction",
    );
    return verifyGatewayEvent({
      receipt,
      hash,
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
  async function archive() {
    const record = load();
    assert(record?.steps.mint, "No saved Gateway withdrawal");
    // Recheck the original exact receipt before clearing the active operation.
    const evidence = await checkMint(record.steps.mint, record);
    assert.equal(
      evidence?.event,
      "AttestationUsed",
      "Original Gateway mint must be verified before archive",
    );
    await journal.archiveMint();
  }
  return { load, quote, authorize, mint, recover, archive };
}
