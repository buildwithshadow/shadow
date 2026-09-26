import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  hexToNumber,
  isAddress,
  parseAbi,
  recoverAddress,
  size,
  slice,
  zeroAddress,
  zeroHash,
} from "viem";
import {
  DEFAULT_SIGNATURE_TTL,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  ERC1271_MAGIC,
  RECEIPT_STATUSES,
  SPEND_INTENT_TYPES,
  eip712Domain,
  walletFromEnv,
} from "./float-mainnet-config.mjs";
import {
  UsageError,
  addressFlag,
  connect,
  durationFlag,
  endpointFlag,
  latestBlock,
  parseAddress,
  parseBytes32,
  parseSignature,
  parseUint,
  predictSpend,
  read,
  readLimits,
  readPolicy,
  required,
  runCli,
  stateName,
  uintFlag,
} from "./float-mainnet-cli.mjs";
import { errorMessage, isEntrypoint, stableStringify } from "./float-mainnet-preflight.mjs";
import { inspectSessionIntent, requireNamedMainnetExecutor } from "./float-mainnet-session.mjs";

// Agent-side SpendIntent tool for the ShadowFloatMainnet candidate.
//
// An external signer (smart account, Circle Agent Wallet) signs the file's
// `externalSignerTypedData` (eth_signTypedData_v4 JSON) or its `digest`, then
// attaches the signature with `verify --signature <hex> --out <path>`, which
// writes the file only when the signature and the intent both check out.

export const INTENT_KIND = "ShadowFloatMainnet.SpendIntent";
// ShadowFloatMainnet.SECP256K1_HALF_ORDER, assembled from its two 16-byte halves.
export const SECP256K1_HALF_ORDER =
  (BigInt("0x7fffffffffffffffffffffffffffffff") << 128n) | BigInt("0x5d576e7357a4501ddfe92f46681b20a0");
const ERC1271_MAGIC_WORD = `${ERC1271_MAGIC}${"0".repeat(56)}`;
const erc1271Abi = parseAbi(["function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)"]);
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

// Decimal-string EIP-712 message (as stored in intent files) -> contract struct.
export function structFromMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("typedData.message is missing");
  const names = SPEND_INTENT_TYPES.SpendIntent.map(({ name }) => name);
  const unexpected = Object.keys(message).filter((key) => !names.includes(key));
  if (unexpected.length) throw new Error(`typedData.message has unexpected fields: ${unexpected.join(", ")}`);
  const struct = {};
  for (const { name, type } of SPEND_INTENT_TYPES.SpendIntent) {
    const label = `typedData.message.${name}`;
    if (type === "address") struct[name] = parseAddress(label, message[name], Error);
    else if (type === "bytes32") struct[name] = parseBytes32(label, message[name], Error);
    else struct[name] = parseUint(label, message[name], Number(type.slice(4)), Error);
  }
  return struct;
}

export function messageFromStruct(struct) {
  return Object.fromEntries(
    SPEND_INTENT_TYPES.SpendIntent.map(({ name, type }) => [
      name,
      type === "address" ? getAddress(struct[name]) : type === "bytes32" ? struct[name].toLowerCase() : struct[name].toString(),
    ]),
  );
}

export function intentDigest(chainId, verifyingContract, struct) {
  return hashTypedData({
    domain: eip712Domain(chainId, verifyingContract),
    types: SPEND_INTENT_TYPES,
    primaryType: "SpendIntent",
    message: struct,
  });
}

// eth_signTypedData_v4 payload for external signers: explicit EIP712Domain
// type, every integer as a decimal string.
export function externalSignerTypedData(chainId, verifyingContract, struct) {
  const domain = eip712Domain(chainId, verifyingContract);
  return JSON.stringify({
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...SPEND_INTENT_TYPES },
    primaryType: "SpendIntent",
    domain: { ...domain, chainId: domain.chainId.toString() },
    message: messageFromStruct(struct),
  });
}

export function intentFile({ chainId, verifyingContract, struct, signature, signerKind }) {
  const domain = eip712Domain(chainId, verifyingContract);
  const file = {
    kind: INTENT_KIND,
    chainId: domain.chainId.toString(),
    verifyingContract: domain.verifyingContract,
    typedData: {
      domain: { ...domain, chainId: domain.chainId.toString() },
      types: SPEND_INTENT_TYPES,
      primaryType: "SpendIntent",
      message: messageFromStruct(struct),
    },
    digest: intentDigest(chainId, verifyingContract, struct),
    externalSignerTypedData: externalSignerTypedData(chainId, verifyingContract, struct),
  };
  if (signature !== undefined) {
    file.signature = signature;
    file.signerKind = signerKind;
  }
  return file;
}

// The wrong-generation / wrong-deployment / altered-payload guard. Every
// command that reads an intent file goes through this.
export function validateIntentFile(file, { chainId, address }) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("intent file is not a JSON object");
  if (file.kind !== INTENT_KIND) {
    throw new Error(
      `not a ${INTENT_KIND} file (kind ${JSON.stringify(file.kind ?? null)}); V2 FloatSpendIntent and other-generation payloads cannot be used with this candidate`,
    );
  }
  const typed = file.typedData ?? {};
  const domain = typed.domain ?? {};
  if (typed.primaryType !== "SpendIntent") throw new Error(`typedData.primaryType is ${JSON.stringify(typed.primaryType ?? null)}, not "SpendIntent"`);
  if (domain.name !== DOMAIN_NAME || domain.version !== DOMAIN_VERSION) {
    throw new Error(
      `EIP-712 domain is ${JSON.stringify(domain.name ?? null)} version ${JSON.stringify(domain.version ?? null)}; this candidate verifies ${DOMAIN_NAME} version ${DOMAIN_VERSION} (wrong-generation payload)`,
    );
  }
  const chain = chainId.toString();
  if (String(domain.chainId) !== chain || String(file.chainId) !== chain) {
    throw new Error(`intent is bound to chain ${domain.chainId ?? file.chainId}; the connected candidate is on chain ${chain}`);
  }
  const bound = [domain.verifyingContract, file.verifyingContract];
  if (!bound.every((value) => typeof value === "string" && isAddress(value) && getAddress(value) === address)) {
    throw new Error(`intent is bound to contract ${domain.verifyingContract ?? file.verifyingContract}; the connected candidate is ${address}`);
  }
  if (!isDeepStrictEqual(typed.types, SPEND_INTENT_TYPES)) throw new Error("typedData.types is not the candidate SpendIntent type");

  const struct = structFromMessage(typed.message);
  const digest = intentDigest(chainId, address, struct);
  if (file.digest !== undefined && String(file.digest).toLowerCase() !== digest) {
    throw new Error(`file digest ${file.digest} does not match its typedData (${digest}); the file was altered`);
  }
  if (file.externalSignerTypedData !== undefined && file.externalSignerTypedData !== externalSignerTypedData(chainId, address, struct)) {
    throw new Error("externalSignerTypedData does not match typedData; the file was altered");
  }
  const signature = file.signature === undefined ? null : parseSignature("signature", file.signature, Error);
  return { struct, digest, signature };
}

export function readIntentFile(path, connection) {
  let file;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read intent file ${path}: ${errorMessage(error)}`);
  }
  return validateIntentFile(file, connection);
}

export function writeJsonFile(path, value) {
  writeFileSync(path, `${stableStringify(value)}\n`);
}

const min = (a, b) => (a < b ? a : b);

// executeSpend at time T requires T + minimumRepaymentWindow <= dueAt <=
// min(T + line window, line expiry). The intent may execute at any T in
// [now, signatureExpiry], so it stays executable for its whole signature
// validity exactly when dueAt >= signatureExpiry + minimumRepaymentWindow and
// dueAt <= min(now + line window, line expiry). The default is the latest such
// dueAt.
export function chooseDueAt({ now, dueIn, signatureExpiry, lineExpiry, lineMaximumRepaymentWindow, minimumRepaymentWindow }) {
  const earliest = signatureExpiry + minimumRepaymentWindow;
  const latest = min(now + lineMaximumRepaymentWindow, lineExpiry);
  const window = `[${earliest}, ${latest}] (signatureExpiry ${signatureExpiry} + minimumRepaymentWindow ${minimumRepaymentWindow}; latest block ${now} + line window ${lineMaximumRepaymentWindow}, line expiry ${lineExpiry})`;
  if (earliest > latest) {
    throw new Error(
      `the line cannot take an intent valid until ${signatureExpiry}: dueAt would have to lie in the empty window ${window}; shorten --signature-ttl, or ask the sponsor to widen the line's repayment window or extend its expiry`,
    );
  }
  if (dueIn === null) return latest;
  const dueAt = now + dueIn;
  if (dueAt < earliest || dueAt > latest) {
    throw new Error(`--due-in ${dueIn} gives dueAt ${dueAt}, outside the window ${window} that keeps the intent executable until its signature expires`);
  }
  return dueAt;
}

// Mirrors the contract's no-code branch of _validateSignature before recovery.
export function eoaSignatureIssue(signature) {
  const length = size(signature);
  if (length !== 65) {
    return `signature is ${length} bytes, but the agent has no code, so the contract requires a 65-byte ECDSA signature by the agent's own key; if the agent is a smart account, deploy it before submitting`;
  }
  const s = BigInt(slice(signature, 32, 64));
  const v = hexToNumber(slice(signature, 64, 65));
  if (v !== 27 && v !== 28) return `signature v is ${v}; the contract accepts only 27 or 28`;
  if (s === 0n || s > SECP256K1_HALF_ORDER) return "signature s is zero or in the upper half of the curve order; the contract requires low-s";
  return null;
}

const check = (ok, detail) => ({ ok, detail });

function failedChecks(checks) {
  return Object.entries(checks)
    .filter(([, entry]) => !entry.ok)
    .map(([name, entry]) => `${name}: ${entry.detail}`)
    .join("; ");
}

// Every condition executeSpend reverts on before it records an outcome,
// evaluated at the latest block, and, when none fails, the outcome it would
// record there: pay, or a SpendBlocked with its reason.
export async function checkFreshness(connection, struct, digest) {
  const { address } = connection;
  const block = await latestBlock(connection);
  const at = (functionName, args) => read(connection, functionName, args, block.number);
  const [
    line,
    activeLineId,
    termsHash,
    minimumRepaymentWindow,
    used,
    cancelled,
    receipt,
    contractDigest,
    policy,
    effectiveLimits,
    totalCommittedCapital,
    spendsPaused,
    sponsorAllowed,
  ] = await Promise.all([
    at("getLine", [struct.lineId]),
    at("activeLineId", [struct.sponsor, struct.agent]),
    at("currentTermsHash", [struct.lineId, struct.provider]),
    at("minimumRepaymentWindow"),
    at("nonceUsed", [struct.lineId, struct.nonce]),
    at("nonceCancelled", [struct.lineId, struct.nonce]),
    at("receiptStatus", [digest]),
    at("hashSpendIntent", [struct]),
    readPolicy(connection, struct.lineId, struct.provider, block.number),
    readLimits(connection, block.number),
    at("totalCommittedCapital"),
    at("spendsPaused"),
    at("sponsorAllowed", [struct.sponsor]),
  ]);
  const now = block.timestamp;
  const state = stateName(line);
  const earliestDueAt = now + minimumRepaymentWindow;
  const latestDueAt = min(now + line.maximumRepaymentWindow, line.expiry);
  const checks = {
    domain: check(true, `chain ${connection.chainId}, contract ${address}`),
    digestMatchesContract: check(contractDigest === digest, `hashSpendIntent returned ${contractDigest}`),
    lineBinding: check(
      line.sponsor === struct.sponsor && line.agent === struct.agent && activeLineId === struct.lineId,
      activeLineId === struct.lineId ? "line is the active line for this sponsor and agent" : `active line for this sponsor and agent is ${activeLineId}`,
    ),
    lineEpoch: check(line.epoch === struct.lineEpoch, `line epoch ${line.epoch}, intent epoch ${struct.lineEpoch}`),
    termsHash: check(
      termsHash === struct.termsHash,
      termsHash === struct.termsHash
        ? "matches currentTermsHash"
        : `currentTermsHash is ${termsHash}; the sponsor changed line or provider terms after this intent was built, so rebuild and re-sign`,
    ),
    lineState: check(state === "OPEN", state === "DRAWN" ? "DRAWN: outstanding debt; repay in full first" : state),
    nonce: check(!used && !cancelled, used ? "nonce already used" : cancelled ? "nonce cancelled by the agent" : "unused"),
    receipt: check(receipt === 0, `receiptStatus ${RECEIPT_STATUSES[receipt]}`),
    amounts: check(
      struct.principal > 0n && struct.principal <= struct.maximumTotalDebt,
      `principal ${struct.principal}, maximumTotalDebt ${struct.maximumTotalDebt}`,
    ),
    signatureExpiry: check(now <= struct.signatureExpiry, `signatureExpiry ${struct.signatureExpiry}, latest block ${now}`),
    dueAtWindow: check(
      struct.dueAt >= earliestDueAt && struct.dueAt <= latestDueAt,
      `dueAt ${struct.dueAt} must lie in [${earliestDueAt}, ${latestDueAt}] at block ${now}; executable until ${min(struct.signatureExpiry, struct.dueAt - minimumRepaymentWindow)}`,
    ),
  };
  const fresh = Object.values(checks).every((entry) => entry.ok);
  const predicted = fresh
    ? {
        ...predictSpend(
          { now, line, policy, effectiveLimits, totalCommittedCapital, spendsPaused, sponsorAllowed, minimumRepaymentWindow },
          struct,
        ),
        observedAt: { blockNumber: block.number, timestamp: now },
      }
    : null;
  return { checks, fresh, now, predicted, policy };
}

// A SpendBlocked is recorded onchain and uses up the nonce without paying the
// provider, so a predicted block is refused unless asked for with --allow-block.
function refuseBlock(predicted, values, action) {
  if (predicted.outcome !== "block" || values["allow-block"] === true) return;
  throw new Error(
    `refusing to ${action} an intent the contract would record as SpendBlocked(${predicted.reason}), using up its nonce and paying nothing: ${predicted.detail}; pass --allow-block to record the refusal deliberately`,
  );
}

// The prediction holds at the latest block only. Executed after its provider
// policy expires, an intent is recorded as SpendBlocked(PROVIDER_NOT_ALLOWED),
// so a signature that outlives the policy needs --allow-block as well.
function refuseExpiringPolicy(policy, struct, values, action) {
  if (policy.expiry >= struct.signatureExpiry || values["allow-block"] === true) return;
  const remedy =
    action === "build"
      ? "shorten --signature-ttl, or ask the sponsor to extend the policy (set-provider-policy --expiry)"
      : "rebuild it with a shorter --signature-ttl, or ask the sponsor to extend the policy (set-provider-policy --expiry) and rebuild";
  throw new Error(
    `refusing to ${action} an intent whose signature expires at ${struct.signatureExpiry}, after provider ${struct.provider}'s policy expiry ${policy.expiry}: executed after ${policy.expiry} the contract would record it as SpendBlocked(PROVIDER_NOT_ALLOWED), using up its nonce and paying nothing; ${remedy}, or pass --allow-block to accept that`,
  );
}

// An unavailable RPC cannot establish an invalid signature. Keep that failure
// distinct from a plain validation Error so HTTP providers can return a
// retryable 500 instead of permanently refusing the intent with 422.
export class SignatureCheckUnavailable extends Error {
  constructor(error) {
    super(`signature verification is unavailable: ${errorMessage(error)}`, { cause: error });
    this.name = "SignatureCheckUnavailable";
  }
}

export function isSignatureRevert(error) {
  // viem also maps this RPC gas-budget error to ExecutionRevertedError. It
  // does not establish that the account rejected this signature.
  const reverted = (cause) => cause instanceof ContractFunctionRevertedError || (
    cause instanceof ExecutionRevertedError && !/gas required exceeds allowance/i.test(cause.details ?? cause.shortMessage)
  );
  return error instanceof BaseError && Boolean(error.walk(reverted));
}

// Mirrors ShadowFloatMainnet._validateSignature: ERC-1271 exactly when the
// agent has code (called from the Float address), otherwise 65-byte low-s ECDSA.
export async function checkSignature(connection, agent, digest, signature) {
  let code;
  try {
    code = await connection.client.getCode({ address: agent });
  } catch (error) {
    throw new SignatureCheckUnavailable(error);
  }
  const signerKind = code && code !== "0x" ? "erc1271" : "eoa";
  if (signature === null) return { signerKind, valid: null, detail: "no signature supplied" };
  if (signerKind === "erc1271") {
    let data;
    try {
      ({ data } = await connection.client.call({
        account: connection.address,
        to: agent,
        data: encodeFunctionData({ abi: erc1271Abi, functionName: "isValidSignature", args: [digest, signature] }),
      }));
    } catch (error) {
      if (!isSignatureRevert(error)) throw new SignatureCheckUnavailable(error);
      return { signerKind, valid: false, detail: `isValidSignature reverted: ${errorMessage(error)}` };
    }
    const valid = data?.toLowerCase() === ERC1271_MAGIC_WORD;
    return {
      signerKind,
      valid,
      detail: valid ? "isValidSignature returned the ERC-1271 magic value" : `isValidSignature returned ${data ?? "0x"}, not ${ERC1271_MAGIC}`,
    };
  }
  const issue = eoaSignatureIssue(signature);
  if (issue) return { signerKind, valid: false, detail: issue };
  let recovered;
  try {
    // Recovery is local parsing/curve arithmetic; malformed r values can
    // throw even when the signature's length, v and low-s checks passed.
    recovered = await recoverAddress({ hash: digest, signature });
  } catch (error) {
    return { signerKind, valid: false, detail: `no key recovers from the signature: ${errorMessage(error)}` };
  }
  return recovered === agent
    ? { signerKind, valid: true, detail: "65-byte low-s ECDSA signature recovers to the agent" }
    : { signerKind, valid: false, detail: `signature recovers to ${recovered}, not the agent ${agent}` };
}

async function unusedNonce(connection, lineId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const nonce = BigInt(`0x${randomBytes(8).toString("hex")}`);
    const [used, cancelled] = await Promise.all([
      read(connection, "nonceUsed", [lineId, nonce]),
      read(connection, "nonceCancelled", [lineId, nonce]),
    ]);
    if (!used && !cancelled) return nonce;
  }
  throw new Error("no unused random nonce found in 8 attempts");
}

async function build(values) {
  const agent = addressFlag(values, "agent");
  const sponsor = addressFlag(values, "sponsor");
  const provider = addressFlag(values, "provider");
  const endpointHash = endpointFlag(values);
  const principal = uintFlag(values, "principal");
  if (principal === 0n) throw new UsageError("--principal must be nonzero");
  const maximumTotalDebt = values["max-total-debt"] === undefined ? principal : uintFlag(values, "max-total-debt");
  if (maximumTotalDebt < principal) throw new UsageError("--max-total-debt must be >= --principal");
  const dueIn = values["due-in"] === undefined ? null : durationFlag(values, "due-in");
  const explicitNonce = values.nonce === undefined ? null : uintFlag(values, "nonce");
  const signatureTtl = values["signature-ttl"] === undefined ? DEFAULT_SIGNATURE_TTL : durationFlag(values, "signature-ttl");
  if (signatureTtl === 0n) throw new UsageError("--signature-ttl must be nonzero");
  const executor = values.executor === undefined ? zeroAddress : addressFlag(values, "executor");

  const connection = await connect(values);
  requireNamedMainnetExecutor(connection, { executor });
  const block = await latestBlock(connection);
  const now = block.timestamp;
  const at = (functionName, args) => read(connection, functionName, args, block.number);

  const lineId = await at("activeLineId", [sponsor, agent]);
  if (lineId === zeroHash) throw new Error(`no active line for sponsor ${sponsor} and agent ${agent}`);
  const [line, termsHash, minimumRepaymentWindow] = await Promise.all([
    at("getLine", [lineId]),
    at("currentTermsHash", [lineId, provider]),
    at("minimumRepaymentWindow"),
  ]);
  const state = stateName(line);
  if (state === "DRAWN") throw new Error(`line ${lineId} has outstanding debt (${line.principalOutstanding}); repay in full first`);
  if (state !== "OPEN") throw new Error(`line ${lineId} is ${state}; only an OPEN line can be drawn`);
  if (now > line.expiry) throw new Error(`line ${lineId} expired at ${line.expiry} (latest block ${now})`);
  const signatureExpiry = now + signatureTtl;
  const dueAt = chooseDueAt({
    now,
    dueIn,
    signatureExpiry,
    lineExpiry: line.expiry,
    lineMaximumRepaymentWindow: line.maximumRepaymentWindow,
    minimumRepaymentWindow,
  });

  let nonce = explicitNonce;
  if (nonce === null) {
    nonce = await unusedNonce(connection, lineId);
  } else {
    const [used, cancelled] = await Promise.all([at("nonceUsed", [lineId, nonce]), at("nonceCancelled", [lineId, nonce])]);
    if (used || cancelled) throw new Error(`nonce ${nonce} is already ${used ? "used" : "cancelled"} on line ${lineId}`);
  }

  const struct = {
    agent,
    sponsor,
    lineId,
    lineEpoch: line.epoch,
    termsHash,
    provider,
    endpointHash,
    principal,
    maximumTotalDebt,
    dueAt,
    nonce,
    signatureExpiry,
    executor,
  };
  const file = intentFile({ chainId: connection.chainId, verifyingContract: connection.address, struct });
  await inspectSessionIntent(values, connection, struct, file.digest);
  const onchainDigest = await at("hashSpendIntent", [struct]);
  if (onchainDigest !== file.digest) {
    throw new Error(`local EIP-712 digest ${file.digest} differs from the contract's hashSpendIntent ${onchainDigest}; refusing to emit this intent`);
  }
  const { checks, fresh, predicted, policy } = await checkFreshness(connection, struct, file.digest);
  if (!fresh) throw new Error(`the built intent is not executable: ${failedChecks(checks)}`);
  refuseBlock(predicted, values, "build");
  refuseExpiringPolicy(policy, struct, values, "build");
  if (values.out !== undefined) writeJsonFile(values.out, file);
  return { ok: true, ...file, checks, predictedOutcome: predicted, out: values.out ?? null };
}

async function sign(values) {
  const path = required(values, "intent");
  const connection = await connect(values);
  const { struct, digest } = readIntentFile(path, connection);
  await inspectSessionIntent(values, connection, struct, digest);
  const { account } = walletFromEnv(connection, "FLOAT_AGENT_PRIVATE_KEY");
  if (account.address !== struct.agent) {
    throw new Error(`FLOAT_AGENT_PRIVATE_KEY belongs to ${account.address}, not the intent's agent ${struct.agent}`);
  }
  const code = await connection.client.getCode({ address: struct.agent });
  if (code && code !== "0x") {
    throw new Error(
      `agent ${struct.agent} has code, so the contract checks ERC-1271; sign the file's externalSignerTypedData with the account's signer and attach it with verify --signature <hex> --out <path>`,
    );
  }
  const { checks, fresh, predicted, policy } = await checkFreshness(connection, struct, digest);
  if (!fresh) throw new Error(`refusing to sign a stale or unexecutable intent: ${failedChecks(checks)}`);
  refuseBlock(predicted, values, "sign");
  refuseExpiringPolicy(policy, struct, values, "sign");

  const signature = await account.signTypedData({
    domain: eip712Domain(connection.chainId, connection.address),
    types: SPEND_INTENT_TYPES,
    primaryType: "SpendIntent",
    message: struct,
  });
  const verdict = await checkSignature(connection, struct.agent, digest, signature);
  if (!verdict.valid) throw new Error(`the new signature does not verify: ${verdict.detail}`);
  const file = intentFile({ chainId: connection.chainId, verifyingContract: connection.address, struct, signature, signerKind: verdict.signerKind });
  const out = values.out ?? path;
  writeJsonFile(out, file);
  return { ok: true, ...file, checks, predictedOutcome: predicted, out };
}

// Reports only: predictedOutcome says whether a submit now would pay or record
// a SpendBlocked, and is null when the intent would revert.
async function verify(values) {
  const path = required(values, "intent");
  const flagSignature = values.signature === undefined ? null : parseSignature("--signature", values.signature);
  const connection = await connect(values);
  const { struct, digest, signature: fileSignature } = readIntentFile(path, connection);
  await inspectSessionIntent(values, connection, struct, digest);
  const signature = flagSignature ?? fileSignature;
  if (values.out !== undefined && signature === null) throw new UsageError("--out attaches a signature; pass --signature <hex>");

  const { checks, fresh, predicted } = await checkFreshness(connection, struct, digest);
  const verdict = await checkSignature(connection, struct.agent, digest, signature);
  const ok = fresh && (signature === null || verdict.valid === true);
  const result = {
    ok,
    digest,
    signerKind: verdict.signerKind,
    signatureValid: verdict.valid,
    signatureDetail: verdict.detail,
    fresh,
    checks,
    predictedOutcome: ok ? predicted : null,
  };
  if (!ok) {
    const problems = [fresh ? null : `not fresh: ${failedChecks(checks)}`, verdict.valid === false ? `invalid signature: ${verdict.detail}` : null];
    result.error = { message: problems.filter(Boolean).join("; "), revert: null };
  } else if (values.out !== undefined) {
    writeJsonFile(
      values.out,
      intentFile({ chainId: connection.chainId, verifyingContract: connection.address, struct, signature, signerKind: verdict.signerKind }),
    );
    result.out = values.out;
  }
  return result;
}

const COMMANDS = {
  build: {
    options: {
      agent: { type: "string" },
      sponsor: { type: "string" },
      provider: { type: "string" },
      endpoint: { type: "string" },
      "endpoint-hash": { type: "string" },
      principal: { type: "string" },
      "max-total-debt": { type: "string" },
      "due-in": { type: "string" },
      nonce: { type: "string" },
      "signature-ttl": { type: "string" },
      executor: { type: "string" },
      session: { type: "string" },
      "allow-block": { type: "boolean" },
      out: { type: "string" },
    },
    run: build,
  },
  sign: { options: { intent: { type: "string" }, session: { type: "string" }, out: { type: "string" }, "allow-block": { type: "boolean" } }, run: sign },
  verify: { options: { intent: { type: "string" }, session: { type: "string" }, signature: { type: "string" }, out: { type: "string" } }, run: verify },
};
const TOOL = "node app/scripts/float-mainnet-intent.mjs";
const USAGE = [
  `${TOOL} build --agent <addr> --sponsor <addr> --provider <addr> (--endpoint <s> | --endpoint-hash <bytes32>) --principal <n> [--max-total-debt <n>] [--due-in <seconds>] [--nonce <n>] [--signature-ttl <seconds>] [--executor <addr>] [--session <policy.json>] [--allow-block] [--out <path>] [--manifest <path>]`,
  `${TOOL} sign --intent <path> [--session <policy.json>] [--out <path>] [--allow-block] [--manifest <path>]   (FLOAT_AGENT_PRIVATE_KEY; EOA agents only)`,
  `${TOOL} verify --intent <path> [--session <policy.json>] [--signature <hex>] [--out <path>] [--manifest <path>]`,
  `Amounts are atomic USDC. --signature-ttl defaults to ${DEFAULT_SIGNATURE_TTL}s; dueAt defaults to the latest value that keeps the intent executable until its signature expires.`,
  "build and sign refuse an intent the contract would record as SpendBlocked (nonce used, provider not paid), or whose signature outlives the provider policy's expiry, unless --allow-block; verify reports predictedOutcome.",
  "Smart-account agents: sign the file's externalSignerTypedData (eth_signTypedData_v4) or digest, then attach it with verify --signature <hex> --out <path>.",
  "Arc mainnet requires an explicit nonzero --executor and --session <policy.json> for build/sign/verify. Initialize that same durable session with float-mainnet-submit.mjs init-session first; preparation checks its exact parties and remaining capacity without reserving a new attempt. Testnet can opt in.",
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
