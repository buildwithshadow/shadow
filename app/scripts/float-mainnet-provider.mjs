import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  hexToNumber,
  isAddress,
  keccak256,
  parseAbi,
  recoverAddress,
  size,
  slice,
  stringToBytes,
  zeroHash,
} from "viem";
import { ERC1271_MAGIC, RECEIPT_STATUSES, walletFromEnv } from "./float-mainnet-config.mjs";
import {
  UsageError,
  bytes32Flag,
  connect,
  endpointFlag,
  failIf,
  findLatestLog,
  fromBlockFlag,
  latestBlock,
  parseAddress,
  parseBytes32,
  parseSignature,
  parseUint,
  read,
  required,
  rpcErrorDetail,
  runCli,
  uintFlag,
} from "./float-mainnet-cli.mjs";
import {
  SECP256K1_HALF_ORDER,
  SignatureCheckUnavailable,
  checkFreshness,
  checkSignature,
  isSignatureRevert,
  readIntentFile,
  validateIntentFile,
  writeJsonFile,
} from "./float-mainnet-intent.mjs";
import { errorMessage, isEntrypoint, stableStringify } from "./float-mainnet-preflight.mjs";
import { checkpointStatus } from "./float-mainnet-indexer.mjs";

// Provider-side kit for the ShadowFloatMainnet candidate (Shadow's own
// convention, not Circle x402). The agent sends its signed intent file before
// paying; the provider checks it and signs a ServiceAcceptance binding its
// requestId to the intent digest; after the executor submits, the provider
// serves only when the contract's receiptStatus[digest] is paid, and signs a
// DeliveryReceipt. The digest commits to provider, endpoint and principal, so a
// paid status proves that exact intent paid this provider. A retry for the same
// digest, under any request id, must return the stored result and receipt: the
// provider's server keeps them by digest (the CLI with --store); nothing here
// pays or re-pays.

export const PROVIDER_DOMAIN_NAME = "ShadowFloatMainnetProvider";
export const PROVIDER_DOMAIN_VERSION = "1";
export const ACCEPTANCE_KIND = "ShadowFloatMainnet.ServiceAcceptance";
export const DELIVERY_KIND = "ShadowFloatMainnet.DeliveryReceipt";
export const SERVICE_ACCEPTANCE_TYPES = {
  ServiceAcceptance: [
    { name: "digest", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "principal", type: "uint256" },
    { name: "requestIdHash", type: "bytes32" },
    { name: "acceptedAt", type: "uint256" },
  ],
};
export const DELIVERY_RECEIPT_TYPES = {
  DeliveryReceipt: [
    { name: "digest", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "requestIdHash", type: "bytes32" },
    { name: "resultHash", type: "bytes32" },
    { name: "resultRefHash", type: "bytes32" },
    { name: "deliveredAt", type: "uint256" },
  ],
};
const RECEIPT_KINDS = {
  [ACCEPTANCE_KIND]: { primaryType: "ServiceAcceptance", types: SERVICE_ACCEPTANCE_TYPES },
  [DELIVERY_KIND]: { primaryType: "DeliveryReceipt", types: DELIVERY_RECEIPT_TYPES },
};
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const KEY = "FLOAT_PROVIDER_PRIVATE_KEY";
const NO_DEDUPLICATION = "none: pass --store, or de-duplicate by digest in your server";
const ERC1271_MAGIC_WORD = `${ERC1271_MAGIC}${"0".repeat(56)}`;
const erc1271Abi = parseAbi(["function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)"]);

export function providerDomain(chainId, verifyingContract) {
  return {
    name: PROVIDER_DOMAIN_NAME,
    version: PROVIDER_DOMAIN_VERSION,
    chainId: BigInt(chainId),
    verifyingContract: getAddress(verifyingContract),
  };
}

// keccak256 of the request id's UTF-8 bytes. A request id that looks like hex
// ("0x61") is still hashed as text, never decoded, so it shares no hash with
// the string those bytes spell ("a").
export function requestIdHashOf(requestId) {
  if (typeof requestId !== "string" || requestId === "") throw new Error("requestId must be a non-empty string");
  return keccak256(stringToBytes(requestId));
}

// A DeliveryReceipt's result location as signed: keccak256 of its UTF-8 bytes,
// or zero when the delivery names none.
export function resultRefHashOf(resultRef) {
  if (resultRef === undefined || resultRef === null) return zeroHash;
  if (typeof resultRef !== "string" || resultRef === "") throw new Error("resultRef must be a non-empty string when given");
  return keccak256(stringToBytes(resultRef));
}

// The EIP-712 payload of a receipt, with bigint integers, for hashing or signing.
export function receiptTypedData(kind, chainId, verifyingContract, message) {
  const { primaryType, types } = RECEIPT_KINDS[kind];
  return { domain: providerDomain(chainId, verifyingContract), types, primaryType, message };
}

// Stored form: integers as decimal strings, addresses checksummed, bytes32 lowercase.
function messageStrings(fields, message) {
  return Object.fromEntries(
    fields.map(({ name, type }) => [
      name,
      type === "address" ? getAddress(message[name]) : type === "bytes32" ? message[name].toLowerCase() : message[name].toString(),
    ]),
  );
}

function parseMessage(fields, message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("typedData.message is missing");
  const names = fields.map(({ name }) => name);
  const unexpected = Object.keys(message).filter((key) => !names.includes(key));
  if (unexpected.length) throw new Error(`typedData.message has unexpected fields: ${unexpected.join(", ")}`);
  const parsed = {};
  for (const { name, type } of fields) {
    const label = `typedData.message.${name}`;
    if (type === "address") parsed[name] = parseAddress(label, message[name], Error);
    else if (type === "bytes32") parsed[name] = parseBytes32(label, message[name], Error);
    else parsed[name] = parseUint(label, message[name], 256, Error);
  }
  return parsed;
}

// Assembles a receipt file from a signature over its EIP-712 payload.
export function receiptFile({ kind, chainId, verifyingContract, message, signature, requestId, resultRef }) {
  const { primaryType, types } = RECEIPT_KINDS[kind];
  const domain = providerDomain(chainId, verifyingContract);
  const file = {
    kind,
    chainId: domain.chainId.toString(),
    verifyingContract: domain.verifyingContract,
    typedData: {
      domain: { ...domain, chainId: domain.chainId.toString() },
      types,
      primaryType,
      message: messageStrings(types[primaryType], message),
    },
    signature,
    signer: getAddress(message.provider),
    requestId,
  };
  if (resultRef !== undefined) file.resultRef = resultRef;
  return file;
}

// account is anything with an address and a viem-style signTypedData.
export async function signReceipt(account, { kind, chainId, verifyingContract, message, requestId, resultRef }) {
  const signature = await account.signTypedData(receiptTypedData(kind, chainId, verifyingContract, message));
  return receiptFile({ kind, chainId, verifyingContract, message, signature, requestId, resultRef });
}

// Checks a receipt file's shape and binding to this chain and Float, and
// recomputes its EIP-712 hash from this module's own domain and types, never
// from the file's. Signature validity is checked separately (signatureAt).
export function validateReceiptFile(file, { chainId, address }, expectedKind) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("receipt file is not a JSON object");
  const spec = RECEIPT_KINDS[file.kind];
  if (!spec) throw new Error(`not a provider receipt (kind ${JSON.stringify(file.kind ?? null)}); expected ${ACCEPTANCE_KIND} or ${DELIVERY_KIND}`);
  if (expectedKind !== undefined && file.kind !== expectedKind) throw new Error(`the receipt is a ${file.kind}, not a ${expectedKind}`);
  const typed = file.typedData ?? {};
  const domain = typed.domain ?? {};
  if (domain.name !== PROVIDER_DOMAIN_NAME || domain.version !== PROVIDER_DOMAIN_VERSION) {
    throw new Error(
      `EIP-712 domain is ${JSON.stringify(domain.name ?? null)} version ${JSON.stringify(domain.version ?? null)}; provider receipts use ${PROVIDER_DOMAIN_NAME} version ${PROVIDER_DOMAIN_VERSION}`,
    );
  }
  const chain = chainId.toString();
  if (String(domain.chainId) !== chain || String(file.chainId) !== chain) {
    throw new Error(`receipt is bound to chain ${domain.chainId ?? file.chainId}; the connected candidate is on chain ${chain}`);
  }
  const bound = [domain.verifyingContract, file.verifyingContract];
  if (!bound.every((value) => typeof value === "string" && isAddress(value) && getAddress(value) === address)) {
    throw new Error(`receipt is bound to contract ${domain.verifyingContract ?? file.verifyingContract}; the connected candidate is ${address}`);
  }
  // The hash is recomputed from these four fields only, so no other may appear in the file's domain.
  const domainKeys = Object.keys(domain).sort();
  if (!isDeepStrictEqual(domainKeys, EIP712_DOMAIN_TYPE.map(({ name }) => name).sort())) {
    throw new Error(`typedData.domain has fields ${domainKeys.join(", ")}; a provider receipt's domain is exactly name, version, chainId and verifyingContract`);
  }
  if (typed.primaryType !== spec.primaryType) throw new Error(`typedData.primaryType is ${JSON.stringify(typed.primaryType ?? null)}, not "${spec.primaryType}"`);
  // An eth_signTypedData_v4 payload also lists the EIP712Domain type; the
  // exporter accepts it, so it is accepted here when it is exactly that domain.
  const { EIP712Domain, ...types } = typed.types ?? {};
  if ((EIP712Domain !== undefined && !isDeepStrictEqual(EIP712Domain, EIP712_DOMAIN_TYPE)) || !isDeepStrictEqual(types, spec.types)) {
    throw new Error(`typedData.types is not the ${spec.primaryType} type`);
  }

  const message = parseMessage(spec.types[spec.primaryType], typed.message);
  const signer = parseAddress("signer", file.signer, Error);
  if (signer !== message.provider) throw new Error(`signer ${signer} is not the receipt's provider ${message.provider}`);
  if (requestIdHashOf(file.requestId) !== message.requestIdHash) {
    throw new Error(`requestId ${JSON.stringify(file.requestId)} does not hash to the message's requestIdHash ${message.requestIdHash}`);
  }
  if (file.kind !== DELIVERY_KIND) {
    if (file.resultRef !== undefined) throw new Error("resultRef is only a string on a DeliveryReceipt");
  } else if (file.resultRef !== undefined && file.resultRef !== null && typeof file.resultRef !== "string") {
    throw new Error("resultRef must be a string, or absent or null when the delivery names no result location");
  } else if (resultRefHashOf(file.resultRef) !== message.resultRefHash) {
    throw new Error(
      typeof file.resultRef === "string"
        ? `resultRef ${JSON.stringify(file.resultRef)} does not hash to the message's resultRefHash ${message.resultRefHash}`
        : `the receipt has no resultRef, but the message's resultRefHash is ${message.resultRefHash}, not zero`,
    );
  }
  return {
    kind: file.kind,
    message,
    requestId: file.requestId,
    resultRef: file.resultRef ?? null,
    signature: parseSignature("signature", file.signature, Error),
    hash: hashTypedData(receiptTypedData(file.kind, chainId, address, message)),
  };
}

// ShadowFloatMainnet._validateSignature's rule, read at blockNumber: ERC-1271
// exactly when `signer` has code there (isValidSignature must return exactly
// the magic value), otherwise a 65-byte low-s ECDSA signature by `signer`.
// caller is the eth_call sender: the Float for a SpendIntent, as the contract
// calls it; none for a provider receipt. blockNumber undefined means latest.
export async function signatureAt(connection, { signer, hash, signature, blockNumber, caller }) {
  let code;
  try {
    code = await connection.client.getCode({ address: signer, blockNumber });
  } catch (error) {
    throw new SignatureCheckUnavailable(error);
  }
  const at = blockNumber === undefined ? "the latest block" : `block ${blockNumber}`;
  if (code && code !== "0x") {
    let data;
    try {
      ({ data } = await connection.client.call({
        account: caller,
        to: signer,
        data: encodeFunctionData({ abi: erc1271Abi, functionName: "isValidSignature", args: [hash, signature] }),
        blockNumber,
      }));
    } catch (error) {
      if (!isSignatureRevert(error)) throw new SignatureCheckUnavailable(error);
      return { signerKind: "erc1271", valid: false, detail: `isValidSignature on ${signer} at ${at} failed: ${rpcErrorDetail(error)}` };
    }
    const valid = data?.toLowerCase() === ERC1271_MAGIC_WORD;
    return {
      signerKind: "erc1271",
      valid,
      detail: valid
        ? `isValidSignature on ${signer} returned the ERC-1271 magic value at ${at}`
        : `isValidSignature on ${signer} returned ${data ?? "0x"} at ${at}, not the magic value ${ERC1271_MAGIC}`,
    };
  }
  const invalid = (detail) => ({ signerKind: "eoa", valid: false, detail });
  const length = size(signature);
  if (length !== 65) return invalid(`signature is ${length} bytes, but ${signer} has no code at ${at}, so only a 65-byte ECDSA signature by its key is valid`);
  const s = BigInt(slice(signature, 32, 64));
  const v = hexToNumber(slice(signature, 64, 65));
  if (v !== 27 && v !== 28) return invalid(`signature v is ${v}; only 27 or 28 is valid`);
  if (s === 0n || s > SECP256K1_HALF_ORDER) return invalid("signature s is zero or in the upper half of the curve order; only low-s is valid");
  let recovered;
  try {
    recovered = await recoverAddress({ hash, signature });
  } catch (error) {
    return invalid(`no key recovers from the signature: ${errorMessage(error)}`);
  }
  return recovered === getAddress(signer)
    ? { signerKind: "eoa", valid: true, detail: `65-byte low-s ECDSA signature recovers to ${signer} (no code at ${at})` }
    : invalid(`signature recovers to ${recovered}, not ${signer}`);
}

// A receipt signature the kit just made, checked the way a verifier will.
async function assertSigned(connection, file, blockNumber) {
  const receipt = validateReceiptFile(file, connection, file.kind);
  const verdict = await signatureAt(connection, { signer: receipt.message.provider, hash: receipt.hash, signature: receipt.signature, blockNumber });
  if (!verdict.valid) throw new Error(`the new ${receipt.kind} signature does not verify: ${verdict.detail}`);
}

// Protocol step 2. The provider checks a signed intent file received before
// payment: it is bound to this chain and Float (its digest recomputes from its
// message), pays this provider at its endpoint at least the price, is signed by
// the agent, and would pay now. Then it signs a ServiceAcceptance binding
// requestId to the digest. acceptedAt is the timestamp of the block the checks
// were read at. Throws with every problem found.
export async function acceptIntent(connection, { intent, endpointHash, price, requestId, account }) {
  const { struct, digest, signature } = validateIntentFile(intent, connection);
  const requestIdHash = requestIdHashOf(requestId);
  const problems = [];
  if (getAddress(account.address) !== struct.provider) problems.push(`the intent pays provider ${struct.provider}, not ${getAddress(account.address)}`);
  if (struct.endpointHash !== endpointHash.toLowerCase()) {
    problems.push(`the intent's endpointHash ${struct.endpointHash} is not this endpoint's ${endpointHash.toLowerCase()}`);
  }
  if (struct.principal < price) problems.push(`the intent's principal ${struct.principal} is below the price ${price}`);
  const { checks, fresh, now, predicted } = await checkFreshness(connection, struct, digest);
  if (!fresh) {
    const failed = Object.entries(checks)
      .filter(([, entry]) => !entry.ok)
      .map(([name, entry]) => `${name}: ${entry.detail}`);
    problems.push(`the intent cannot be executed now (${failed.join("; ")})`);
  } else if (predicted.outcome !== "pay") {
    problems.push(`the contract would record it as SpendBlocked(${predicted.reason}) and pay nothing: ${predicted.detail}`);
  }
  if (signature === null) {
    problems.push("the intent file carries no signature; the agent signs it before sending it to the provider");
  } else {
    const verdict = await checkSignature(connection, struct.agent, digest, signature);
    if (!verdict.valid) problems.push(`the agent's signature does not verify: ${verdict.detail}`);
  }
  failIf(problems);

  const acceptance = await signReceipt(account, {
    kind: ACCEPTANCE_KIND,
    chainId: connection.chainId,
    verifyingContract: connection.address,
    message: { digest, provider: struct.provider, endpointHash: struct.endpointHash, principal: struct.principal, requestIdHash, acceptedAt: now },
    requestId,
  });
  await assertSigned(connection, acceptance);
  return { acceptance, digest, predicted };
}

// Protocol step 4. receiptStatus[digest] read from the contract is
// authoritative; the ProviderPaid log is looked up for reference only, so a
// lookup that finds nothing or fails leaves providerPaid null with a hint.
// fromBlock bounds the lookup (null: the last MAX_LOOKBACK_BLOCKS blocks).
export async function checkPayment(connection, digest, { fromBlock = connection.deployBlock } = {}) {
  const block = await connection.client.getBlock();
  const status = Number(await read(connection, "receiptStatus", [digest], block.number));
  const result = {
    observedAt: { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp },
    digest,
    paid: status === 2,
    receiptStatus: RECEIPT_STATUSES[status],
    providerPaid: null,
  };
  if (status === 2) {
    try {
      const { log, fromBlock: scannedFrom } = await findLatestLog(connection, "ProviderPaid", { digest }, { fromBlock, toBlock: block.number });
      if (!log) {
        result.hint = `receiptStatus is paid (authoritative), but no ProviderPaid log for this digest is in blocks ${scannedFrom}-${block.number}; pass an earlier --from-block`;
      } else {
        result.providerPaid = {
          blockNumber: log.blockNumber,
          dueAt: log.args.dueAt,
          lineId: log.args.lineId,
          principal: log.args.principal,
          provider: log.args.provider,
          transactionHash: log.transactionHash,
        };
      }
    } catch (error) {
      result.hint = `receiptStatus is paid (authoritative); looking up its ProviderPaid log failed (${rpcErrorDetail(error)}); retry, or narrow the scan with --from-block <n>`;
    }
  }
  await assertPaymentCanonical(connection, result);
  return result;
}

// Recheck after asynchronous delivery checks too: number-pinned reads are not
// sufficient when the chain can replace that height while a request runs.
export async function assertPaymentCanonical(connection, payment) {
  const { canonical, canonicalHash } = await checkpointStatus(connection, payment.observedAt);
  if (!canonical) {
    throw new Error(`the payment observation block was reorganized: block ${payment.observedAt.blockNumber} is now ${canonicalHash ?? "missing"}, not ${payment.observedAt.blockHash}; retry the payment check`);
  }
}

// Protocol step 4, delivery. Refuses unless receiptStatus[digest] is paid and,
// when its ProviderPaid log is found, that payment went to the acceptance's
// provider for its principal; then signs a DeliveryReceipt for the accepted
// request. crossCheck says whether the log was compared or why not.
// deliveredAt is the timestamp of the block the payment was read at.
async function checkDeliveryPayment(connection, { acceptance, account, fromBlock }) {
  const accepted = validateReceiptFile(acceptance, connection, ACCEPTANCE_KIND);
  const { digest, provider } = accepted.message;
  if (getAddress(account.address) !== provider) throw new Error(`the acceptance is provider ${provider}'s, not ${getAddress(account.address)}'s`);
  const payment = await checkPayment(connection, digest, { fromBlock: fromBlock ?? connection.deployBlock });
  const acceptanceSignature = await signatureAt(connection, {
    signer: provider,
    hash: accepted.hash,
    signature: accepted.signature,
    blockNumber: payment.observedAt.blockNumber,
  });
  if (!acceptanceSignature.valid) throw new Error(`the acceptance is not signed by provider ${provider}: ${acceptanceSignature.detail}`);
  if (!payment.paid) {
    const why = payment.receiptStatus === "blocked" ? "the contract recorded a refusal and paid nothing" : "nothing has been paid for it";
    throw new Error(
      `refusing to deliver: receiptStatus for digest ${digest} is ${payment.receiptStatus} at block ${payment.observedAt.blockNumber} (${why}); only a paid digest is served`,
    );
  }
  let crossCheck = `skipped: ${payment.hint}`;
  if (payment.providerPaid) {
    const paid = payment.providerPaid;
    if (getAddress(paid.provider) !== provider || paid.principal !== accepted.message.principal) {
      throw new Error(
        `refusing to deliver: digest ${digest} paid provider ${paid.provider} principal ${paid.principal} (ProviderPaid in ${paid.transactionHash}), not this acceptance's provider ${provider} principal ${accepted.message.principal}`,
      );
    }
    crossCheck = `passed: ProviderPaid in ${paid.transactionHash} pays this acceptance's provider and principal`;
  }
  await assertPaymentCanonical(connection, payment);
  return { accepted, payment, crossCheck };
}

export async function deliverResult(connection, { acceptance, resultHash, resultRef, account, fromBlock }) {
  const { accepted, payment, crossCheck } = await checkDeliveryPayment(connection, { acceptance, account, fromBlock });
  const { digest, provider, requestIdHash } = accepted.message;
  const delivery = await signReceipt(account, {
    kind: DELIVERY_KIND,
    chainId: connection.chainId,
    verifyingContract: connection.address,
    message: {
      digest,
      provider,
      requestIdHash,
      resultHash: parseBytes32("resultHash", resultHash, Error),
      resultRefHash: resultRefHashOf(resultRef),
      deliveredAt: payment.observedAt.timestamp,
    },
    requestId: accepted.requestId,
    resultRef,
  });
  await assertSigned(connection, delivery, payment.observedAt.blockNumber);
  await assertPaymentCanonical(connection, payment);
  return { delivery, payment, crossCheck };
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${what} file ${path}: ${errorMessage(error)}`);
  }
}

// The CLI signs with an EOA key. A provider address with code has its receipts
// checked with ERC-1271, which that key cannot satisfy.
async function providerAccount(connection) {
  const { account } = walletFromEnv(connection, KEY);
  const code = await connection.client.getCode({ address: account.address });
  if (code && code !== "0x") {
    throw new Error(
      `${account.address} has code, so its receipts are checked with ERC-1271; call this module's acceptIntent and deliverResult with a custom account { address, signTypedData } that signs with the account's signer, so every acceptance and delivery check still runs`,
    );
  }
  return account;
}

// --store <dir> keeps one acceptance and one delivery per digest, whatever the
// request id. Each is written in full to a temporary file in the same directory
// and then hard-linked to its name, which fails if the name exists: a stored
// file is never partial, and two runs at once cannot both store one. The store
// therefore needs a filesystem with hard links.
function storeFile(store, digest, slot) {
  mkdirSync(store, { recursive: true });
  return join(store, `${digest}.${slot}.json`);
}

// The receipt stored at `file` for this key, digest and requestId, or null when
// none is stored. A file that names another provider (a store shared by two
// keys) or another digest is refused, and so is one whose signature does not
// verify at the latest block; so is one stored for another request id: a paid
// digest is served once.
async function storedReceipt(file, connection, kind, { account, digest, requestId }) {
  if (!existsSync(file)) return null;
  const stored = readJson(file, "stored receipt");
  let receipt;
  try {
    receipt = validateReceiptFile(stored, connection, kind);
  } catch (error) {
    throw new Error(`${file}: ${errorMessage(error)} (a receipt stored before a format change is not reused; remove it only once nothing depends on it)`);
  }
  const [done, second] = kind === ACCEPTANCE_KIND ? ["accepted", "acceptance"] : ["delivered", "delivery"];
  const provider = getAddress(account.address);
  if (receipt.message.provider !== provider) {
    throw new Error(`${file} holds provider ${receipt.message.provider}'s ${second}, not ${provider}'s; refusing to return it`);
  }
  if (receipt.message.digest !== digest) throw new Error(`${file} holds the ${second} of digest ${receipt.message.digest}, not ${digest}; refusing to return it`);
  const verdict = await signatureAt(connection, { signer: provider, hash: receipt.hash, signature: receipt.signature });
  if (!verdict.valid) throw new Error(`the ${second} stored at ${file} has a signature that does not verify (${verdict.detail}); refusing to return it`);
  if (receipt.requestId !== requestId) {
    throw new Error(
      `digest ${receipt.message.digest} is already ${done} for request ${JSON.stringify(receipt.requestId)} (${file}); refusing a second ${second} for request ${JSON.stringify(requestId)}`,
    );
  }
  return stored;
}

// False when another run stored the file first. The temporary file is removed
// whether the write or the link fails or succeeds; when it is already gone, or
// Windows holds it (EBUSY, EPERM), the outcome stands: a leftover is never read.
function storeOnce(file, receipt) {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${stableStringify(receipt)}\n`, { flag: "wx" });
    try {
      linkSync(temporary, file);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EPERM"].includes(error.code)) throw error;
    }
  }
}

async function accept(values) {
  const path = required(values, "intent");
  const endpointHash = endpointFlag(values);
  const price = uintFlag(values, "price");
  const requestId = required(values, "request-id");
  const connection = await connect(values);
  const account = await providerAccount(connection);
  const intent = readJson(path, "intent");
  const checked = validateIntentFile(intent, connection);
  const binding = { account, digest: checked.digest, requestId };
  const file = values.store === undefined ? null : storeFile(values.store, binding.digest, "acceptance");
  const returned = (stored) => {
    if (values.out !== undefined) writeJsonFile(values.out, stored);
    const deduplication = `returned the acceptance stored at ${file} for this digest; nothing re-signed`;
    return { ok: true, ...stored, digest: stored.typedData.message.digest, predictedOutcome: null, deduplication, out: values.out ?? null };
  };
  const stored = file && (await storedReceipt(file, connection, ACCEPTANCE_KIND, binding));
  if (stored) {
    // acceptIntent is skipped, so its signature check runs here: the stored
    // acceptance goes only to an intent its agent signed.
    if (checked.signature === null) throw new Error("the intent file carries no signature; the agent signs it before sending it to the provider");
    const verdict = await checkSignature(connection, checked.struct.agent, checked.digest, checked.signature);
    if (!verdict.valid) throw new Error(`the agent's signature does not verify: ${verdict.detail}`);
    return returned(stored);
  }
  const { acceptance, digest, predicted } = await acceptIntent(connection, { intent, endpointHash, price, requestId, account });
  if (file && !storeOnce(file, acceptance)) return returned(await storedReceipt(file, connection, ACCEPTANCE_KIND, binding));
  if (values.out !== undefined) writeJsonFile(values.out, acceptance);
  const deduplication = file ? `stored at ${file}` : NO_DEDUPLICATION;
  return { ok: true, ...acceptance, digest, predictedOutcome: predicted, deduplication, out: values.out ?? null };
}

async function checkPaymentCommand(values) {
  const byIntent = values.intent !== undefined;
  if (byIntent === (values.digest !== undefined)) throw new UsageError("pass --intent <signed.json> or --digest <bytes32>");
  const digestFlag = byIntent ? null : bytes32Flag(values, "digest");
  const fromBlock = fromBlockFlag(values);
  const connection = await connect(values);
  const digest = digestFlag ?? readIntentFile(values.intent, connection).digest;
  const accepted = values.acceptance === undefined ? null : validateReceiptFile(readJson(values.acceptance, "acceptance"), connection, ACCEPTANCE_KIND);
  if (accepted && accepted.message.digest !== digest) throw new Error(`the acceptance is for digest ${accepted.message.digest}, not ${digest}`);
  const payment = await checkPayment(connection, digest, { fromBlock: fromBlock ?? connection.deployBlock });
  if (!accepted) return { ok: true, ...payment, acceptance: null };
  const verdict = await signatureAt(connection, {
    signer: accepted.message.provider,
    hash: accepted.hash,
    signature: accepted.signature,
    blockNumber: payment.observedAt.blockNumber,
  });
  await assertPaymentCanonical(connection, payment);
  const result = {
    ok: verdict.valid,
    ...payment,
    acceptance: {
      requestId: accepted.requestId,
      provider: accepted.message.provider,
      principal: accepted.message.principal,
      acceptedAt: accepted.message.acceptedAt,
      signatureValid: verdict.valid,
      signatureDetail: verdict.detail,
    },
  };
  if (!verdict.valid) result.error = { message: `the acceptance is not signed by provider ${accepted.message.provider}: ${verdict.detail}`, revert: null };
  return result;
}

async function deliver(values) {
  const path = required(values, "acceptance");
  const byFile = values["result-file"] !== undefined;
  if (byFile === (values["result-hash"] !== undefined)) throw new UsageError("pass --result-file <path> or --result-hash <bytes32>");
  const resultHash = byFile ? keccak256(readFileSync(values["result-file"])) : bytes32Flag(values, "result-hash");
  const fromBlock = fromBlockFlag(values);
  const connection = await connect(values);
  const account = await providerAccount(connection);
  const acceptance = readJson(path, "acceptance");
  const accepted = validateReceiptFile(acceptance, connection, ACCEPTANCE_KIND);
  const binding = { account, digest: accepted.message.digest, requestId: accepted.requestId };
  const file = values.store === undefined ? null : storeFile(values.store, binding.digest, "delivery");
  const returned = async (stored) => {
    const { payment, crossCheck } = await checkDeliveryPayment(connection, { acceptance, account, fromBlock });
    if (values.out !== undefined) writeJsonFile(values.out, stored);
    const deduplication = `returned the delivery stored at ${file} for this digest; nothing re-signed`;
    return { ok: true, ...stored, payment, crossCheck, deduplication, out: values.out ?? null };
  };
  const stored = file && (await storedReceipt(file, connection, DELIVERY_KIND, binding));
  if (stored) return returned(stored);
  const { delivery, payment, crossCheck } = await deliverResult(connection, { acceptance, resultHash, resultRef: values["result-ref"], account, fromBlock });
  if (file && !storeOnce(file, delivery)) return returned(await storedReceipt(file, connection, DELIVERY_KIND, binding));
  if (values.out !== undefined) writeJsonFile(values.out, delivery);
  const deduplication = file ? `stored at ${file}` : NO_DEDUPLICATION;
  return { ok: true, ...delivery, payment, crossCheck, deduplication, out: values.out ?? null };
}

async function verifyReceipt(values) {
  const path = required(values, "file");
  const connection = await connect(values);
  const receipt = validateReceiptFile(readJson(path, "receipt"), connection);
  const block = await latestBlock(connection);
  const verdict = await signatureAt(connection, {
    signer: receipt.message.provider,
    hash: receipt.hash,
    signature: receipt.signature,
    blockNumber: block.number,
  });
  const result = {
    ok: verdict.valid,
    kind: receipt.kind,
    digest: receipt.message.digest,
    provider: receipt.message.provider,
    requestId: receipt.requestId,
    signerKind: verdict.signerKind,
    signatureValid: verdict.valid,
    signatureDetail: verdict.detail,
    observedAt: { blockNumber: block.number, timestamp: block.timestamp },
  };
  if (!verdict.valid) result.error = { message: `the receipt is not signed by provider ${receipt.message.provider}: ${verdict.detail}`, revert: null };
  return result;
}

const COMMANDS = {
  accept: {
    options: {
      intent: { type: "string" },
      endpoint: { type: "string" },
      "endpoint-hash": { type: "string" },
      price: { type: "string" },
      "request-id": { type: "string" },
      out: { type: "string" },
      store: { type: "string" },
    },
    run: accept,
  },
  "check-payment": {
    options: { intent: { type: "string" }, digest: { type: "string" }, acceptance: { type: "string" }, "from-block": { type: "string" } },
    run: checkPaymentCommand,
  },
  deliver: {
    options: {
      acceptance: { type: "string" },
      "result-file": { type: "string" },
      "result-hash": { type: "string" },
      "result-ref": { type: "string" },
      "from-block": { type: "string" },
      out: { type: "string" },
      store: { type: "string" },
    },
    run: deliver,
  },
  "verify-receipt": { options: { file: { type: "string" } }, run: verifyReceipt },
};
const TOOL = "node app/scripts/float-mainnet-provider.mjs";
const USAGE = [
  `${TOOL} accept --intent <signed.json> (--endpoint <s> | --endpoint-hash <bytes32>) --price <n> --request-id <id> [--store <dir>] [--out <path>] [--manifest <path>]   (${KEY})`,
  `${TOOL} check-payment (--intent <signed.json> | --digest <bytes32>) [--acceptance <path>] [--from-block <n>] [--manifest <path>]`,
  `${TOOL} deliver --acceptance <path> (--result-file <path> | --result-hash <bytes32>) [--result-ref <s>] [--from-block <n>] [--store <dir>] [--out <path>] [--manifest <path>]   (${KEY})`,
  `${TOOL} verify-receipt --file <receipt.json> [--manifest <path>]`,
  "accept refuses an intent that does not pay this key's address at this endpoint at least --price, is unsigned or wrongly signed, or would not pay now; it signs a ServiceAcceptance binding --request-id to the intent digest.",
  "deliver refuses unless the contract's receiptStatus for the accepted digest is paid and, when its ProviderPaid log is found, that payment went to the acceptance's provider and principal (crossCheck says which); it signs a DeliveryReceipt with keccak256 of the result and of --result-ref's UTF-8 bytes (zero without --result-ref), so the result location in the file cannot be changed without breaking the signature.",
  "Serve a digest once, whatever the request id. --store <dir> (on a filesystem with hard links) keeps one acceptance and one delivery per digest, each written in full before it is linked into place: accept returns the stored acceptance for the same --request-id and refuses another; deliver returns the stored delivery for the same request id and refuses another. Either refuses a stored receipt that names another provider or another digest, or whose signature does not verify. Two concurrent first runs for a digest may both sign, but only one receipt is stored, and that one is returned. Without --store, de-duplicate by digest in your server.",
  `Receipts are EIP-712 (${PROVIDER_DOMAIN_NAME} version ${PROVIDER_DOMAIN_VERSION}, bound to the chain and Float). ${KEY} is an EOA key (never printed); a provider address with code is checked with ERC-1271 and calls acceptIntent and deliverResult with its own signer.`,
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
