import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  stringToHex,
} from "viem";
import abi from "../scripts/float-mainnet-abi.json" with { type: "json" };

// Wallet-executed testnet purchases. No enrollment bearer token or server signer.
const TYPES = {
  SpendIntent: abi
    .find((x) => x.name === "executeSpend")
    .inputs[0].components.map(({ name, type }) => ({ name, type })),
};
const DOMAIN_FIELDS = [
  "name:string",
  "version:string",
  "chainId:uint256",
  "verifyingContract:address",
].map((x) => {
  const [name, type] = x.split(":");
  return { name, type };
});
const ACCEPTANCE = {
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
const DELIVERY = {
  DeliveryReceipt: [
    "digest:bytes32",
    "provider:address",
    "requestIdHash:bytes32",
    "resultHash:bytes32",
    "resultRefHash:bytes32",
    "deliveredAt:uint256",
  ].map((x) => {
    const [name, type] = x.split(":");
    return { name, type };
  }),
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const textHash = (x) => keccak256(stringToHex(x));
const serial = (x) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const locks = new Set();
export function createSelfServicePurchase({
  client,
  wallet,
  config,
  storage,
  fetchImpl = fetch,
  withLock = async (key, work) => {
    assert(
      globalThis.navigator?.locks,
      "This browser cannot safely coordinate wallet requests. Use a browser with Web Locks support.",
    );
    return navigator.locks.request(key, { ifAvailable: true }, (lock) => {
      assert(lock, "Another tab is using this purchase.");
      return work();
    });
  },
  random = () => crypto.getRandomValues(new Uint8Array(32)),
}) {
  config = Object.freeze({ ...config });
  assert(config.chainId === 5042002, "Only Arc testnet is supported.");
  const account = getAddress(config.account),
    contract = getAddress(config.contract),
    provider = getAddress(config.provider);
  const origin = new URL(config.providerUrl);
  assert(
    origin.protocol === "https:" &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash,
    "Provider must use a fixed HTTPS URL.",
  );
  const key = `shadow.public-purchase.v1:${config.chainId}:${contract}:${account}`;
  const read = async (name, args = []) => {
    const result = await client.readContract({
      address: contract,
      abi,
      functionName: name,
      args,
    });
    // Solidity's public mapping getter returns multiple outputs, not a tuple object.
    if (name === "lines" && Array.isArray(result)) {
      return Object.fromEntries(
        abi
          .find((entry) => entry.name === name)
          .outputs.map((field, index) => [field.name, result[index]]),
      );
    }
    return result;
  };
  const domain = {
    name: "ShadowFloatMainnet",
    version: "1",
    chainId: config.chainId,
    verifyingContract: contract,
  };
  function save(record) {
    const value = serial(record);
    storage.setItem(key, value);
    assert(
      storage.getItem(key) === value,
      "Recovery record could not be persisted.",
    );
  }
  function load() {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw);
    assert(
      record.account === account &&
        record.contract === contract &&
        record.chainId === config.chainId,
      "Recovery record belongs to another wallet or deployment.",
    );
    validate(record);
    return record;
  }
  function validate(record) {
    const i = record.intent,
      t = i?.typedData,
      m = t?.message;
    assert(
      i?.kind === "ShadowFloatMainnet.SpendIntent" &&
        i.chainId === String(config.chainId) &&
        same(i.verifyingContract, contract),
      "Wrong intent deployment.",
    );
    assert(
      t?.domain?.name === domain.name &&
        t.domain.version === domain.version &&
        Number(t.domain.chainId) === config.chainId &&
        same(t.domain.verifyingContract, contract) &&
        t.primaryType === "SpendIntent" &&
        serial(t.types) === serial(TYPES),
      "Wrong signing domain or schema.",
    );
    assert(
      m &&
        same(m.agent, account) &&
        same(m.executor, account) &&
        same(m.provider, provider) &&
        same(m.endpointHash, textHash(config.endpoint)) &&
        BigInt(m.principal) === BigInt(config.principal) &&
        BigInt(m.maximumTotalDebt) === BigInt(config.principal),
      "Purchase exceeds the selected service authorization.",
    );
    const payload = serial({
      types: { EIP712Domain: DOMAIN_FIELDS, ...TYPES },
      primaryType: "SpendIntent",
      domain: { ...domain, chainId: String(config.chainId) },
      message: m,
    });
    assert(
      i.externalSignerTypedData === payload && same(i.digest, hashTypedData(t)),
      "Purchase intent was altered.",
    );
  }
  async function identity() {
    assert(
      (await client.getChainId()) === config.chainId,
      "Switch to Arc testnet.",
    );
    const code = await client.getCode({ address: contract });
    assert(
      code && keccak256(code) === config.runtimeHash,
      "Contract does not match the approved release.",
    );
  }
  async function connected() {
    await identity();
    assert(
      (await wallet.getChainId()) === config.chainId,
      "Switch your wallet to Arc testnet.",
    );
    const addresses = await wallet.getAddresses();
    assert(
      same(addresses[0], account),
      "Wallet changed. Reconnect before continuing.",
    );
  }
  async function post(path, body) {
    const response = await fetchImpl(
      `${config.providerUrl.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: serial(body),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    assert(
      response.ok,
      `Provider unavailable (${response.status}). Keep the original purchase and retry recovery.`,
    );
    const text = await response.text();
    assert(text.length <= 1_000_000, "Provider response is too large.");
    return JSON.parse(text);
  }
  async function signedReceipt(file, types, primaryType) {
    const expected = {
      name: "ShadowFloatMainnetProvider",
      version: "1",
      chainId: config.chainId,
      verifyingContract: contract,
    };
    assert(
      file?.typedData?.primaryType === primaryType &&
        same(file.typedData.domain?.verifyingContract, contract) &&
        Number(file.typedData.domain.chainId) === config.chainId &&
        file.typedData.domain.name === expected.name &&
        file.typedData.domain.version === "1",
      "Wrong provider receipt domain.",
    );
    assert(
      await client.verifyTypedData({
        address: provider,
        domain: expected,
        types,
        primaryType,
        message: file.typedData.message,
        signature: file.signature,
      }),
      "Provider receipt signature is invalid.",
    );
    return file.typedData.message;
  }
  async function prepare(lineId, requestId) {
    await connected();
    assert(!load(), "Recover the existing purchase before starting another.");
    assert(
      typeof requestId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId),
      "A stable service request ID is required.",
    );
    const line = await read("lines", [lineId]);
    assert(
      same(line.agent, account),
      "This wallet is not the agent authorized by the sponsor.",
    );
    assert(
      Number(line.state) === 1,
      "Funding line must be open with no outstanding purchase.",
    );
    assert(
      same(await read("activeLineId", [line.sponsor, account]), lineId),
      "Funding line was replaced.",
    );
    const principal = BigInt(config.principal);
    assert(
      principal > 0n &&
        principal <= 1000000n &&
        principal <= line.availableReserve,
      "Insufficient authorized testnet funding.",
    );
    const block = await client.getBlock();
    const minimum = await read("minimumRepaymentWindow");
    const dueAt = block.timestamp + minimum + 300n;
    assert(
      dueAt <= line.expiry && minimum + 300n <= line.maximumRepaymentWindow,
      "Funding line repayment window is too short.",
    );
    const nonce = BigInt(
      `0x${Array.from(random(), (x) => x.toString(16).padStart(2, "0")).join("")}`,
    );
    const message = {
      agent: account,
      sponsor: line.sponsor,
      lineId,
      lineEpoch: line.epoch,
      termsHash: await read("currentTermsHash", [lineId, provider]),
      provider,
      endpointHash: textHash(config.endpoint),
      principal,
      maximumTotalDebt: principal,
      dueAt,
      nonce,
      signatureExpiry: block.timestamp + 600n,
      executor: account,
    };
    const typedData = {
      domain,
      types: TYPES,
      primaryType: "SpendIntent",
      message,
    };
    const digest = hashTypedData(typedData);
    const intent = {
      kind: "ShadowFloatMainnet.SpendIntent",
      chainId: String(config.chainId),
      verifyingContract: contract,
      typedData: JSON.parse(serial(typedData)),
      digest,
    };
    intent.externalSignerTypedData = serial({
      types: { EIP712Domain: DOMAIN_FIELDS, ...TYPES },
      primaryType: "SpendIntent",
      domain: { ...domain, chainId: String(config.chainId) },
      message: JSON.parse(serial(message)),
    });
    const record = {
      version: 1,
      chainId: config.chainId,
      account,
      contract,
      requestId,
      intent,
      stage: "prepared",
      txHash: null,
    };
    save(record);
    return record;
  }
  async function submit() {
    assert(!locks.has(key), "A wallet request is already running.");
    locks.add(key);
    try {
      await connected();
      let record = load();
      assert(record, "Prepare a purchase first.");
      assert(
        record.stage === "prepared" || record.stage === "accepted",
        "The original payment needs reconciliation; do not send again.",
      );
      const intent = record.intent;
      assert(
        same(intent.digest, hashTypedData(intent.typedData)),
        "Purchase intent was altered.",
      );
      assert(
        same(intent.typedData.message.agent, account) &&
          same(intent.typedData.message.executor, account) &&
          same(intent.verifyingContract, contract),
        "Purchase wallet or contract changed.",
      );
      if (record.stage === "prepared") {
        const signature = await wallet.request({
          method: "eth_signTypedData_v4",
          params: [account, intent.externalSignerTypedData],
        });
        await connected();
        assert(
          await client.verifyTypedData({
            address: account,
            ...intent.typedData,
            signature,
          }),
          "Agent signature is invalid.",
        );
        intent.signature = signature;
        const acceptance = await post("/accept", {
          intent,
          requestId: record.requestId,
        });
        const a = await signedReceipt(
          acceptance,
          ACCEPTANCE,
          "ServiceAcceptance",
        );
        const block = await client.getBlock();
        assert(
          same(a.digest, intent.digest) &&
            same(a.provider, provider) &&
            same(a.endpointHash, intent.typedData.message.endpointHash) &&
            BigInt(a.principal) === BigInt(config.principal) &&
            same(a.requestIdHash, textHash(record.requestId)) &&
            BigInt(a.acceptedAt) <= block.timestamp,
          "Provider accepted a different request.",
        );
        record.acceptance = acceptance;
        record.stage = "accepted";
        save(record);
      }
      await connected();
      const simulation = await client.simulateContract({
        address: contract,
        abi,
        functionName: "executeSpend",
        args: [intent.typedData.message, intent.signature],
        account,
      });
      assert(
        simulation.result?.[0] === true,
        "The funding policy refused this purchase. No transaction was requested.",
      );
      // Persist BEFORE requesting a transaction. A lost wallet response is never auto-retried.
      record.stage = "submitted";
      save(record);
      try {
        record.txHash = await wallet.sendTransaction({
          account,
          chain: wallet.chain,
          to: contract,
          data: encodeFunctionData({
            abi,
            functionName: "executeSpend",
            args: [intent.typedData.message, intent.signature],
          }),
          value: 0n,
        });
        save(record);
      } catch (error) {
        if (error?.code === 4001) {
          record.stage = "accepted";
          save(record);
        }
        throw error;
      }
      return record;
    } finally {
      locks.delete(key);
    }
  }
  async function recover() {
    await identity();
    const record = load();
    assert(record, "No saved purchase.");
    const status = Number(await read("receiptStatus", [record.intent.digest]));
    if (status !== 2)
      return { record, status: status === 1 ? "blocked" : "unconfirmed" };
    const result =
      record.stage === "delivered"
        ? record.result
        : await post("/serve", { digest: record.intent.digest });
    const d = await signedReceipt(result.delivery, DELIVERY, "DeliveryReceipt");
    assert(
      same(d.digest, record.intent.digest) &&
        same(d.provider, provider) &&
        same(d.requestIdHash, textHash(record.requestId)),
      "Delivery belongs to a different purchase.",
    );
    assert(typeof result.result === "string", "Provider result is missing.");
    assert(result.result.length <= 1_000_000, "Provider result is too large.");
    const decoded = atob(result.result);
    assert(
      btoa(decoded) === result.result,
      "Provider result is not canonical base64.",
    );
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    const ref = result.delivery.resultRef;
    assert(
      same(d.resultRefHash, ref ? textHash(ref) : `0x${"0".repeat(64)}`),
      "Provider result reference was altered.",
    );
    assert(
      same(keccak256(bytes), d.resultHash),
      "Provider result does not match its signed receipt.",
    );
    assert(
      Number(await read("receiptStatus", [record.intent.digest])) === 2,
      "Payment needs reconciliation.",
    );
    record.stage = "delivered";
    record.result = result;
    save(record);
    return { record, status: "delivered", bytes };
  }
  // Completion does not silently erase ambiguous payment state.
  async function archive() {
    const record = load();
    assert(
      record?.stage === "delivered",
      "Only a delivered purchase can be archived.",
    );
    await identity();
    assert(
      Number(await read("receiptStatus", [record.intent.digest])) === 2,
      "Payment needs reconciliation.",
    );
    storage.setItem(`${key}:${record.intent.digest}`, serial(record));
    storage.removeItem(key);
  }
  return {
    prepare: (...args) => withLock(key, () => prepare(...args)),
    submit: () => withLock(key, submit),
    recover: () => withLock(key, recover),
    archive: () => withLock(key, archive),
    load,
  };
}
