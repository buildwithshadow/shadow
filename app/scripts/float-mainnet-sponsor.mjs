import { encodeAbiParameters, isAddressEqual, keccak256, parseAbiParameters, zeroAddress, zeroHash } from "viem";
import { DEFAULT_SIGNATURE_TTL, floatAbi } from "./float-mainnet-config.mjs";
import {
  WRITE_OPTIONS,
  addressFlag,
  afterSend,
  bytes32Flag,
  connect,
  durationFlag,
  endpointFlag,
  failIf,
  latestBlock,
  read,
  readLimits,
  readLine,
  readPolicy,
  runCalls,
  runCli,
  signerFor,
  stateName,
  timeFlag,
  uintFlag,
  usdcFunding,
  writeMode,
} from "./float-mainnet-cli.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";

// Sponsor actions on the ShadowFloatMainnet candidate: open a line, change its
// provider policy or terms, close it, and recover after a default.

const KEY = "FLOAT_SPONSOR_PRIVATE_KEY";

function floatCall(connection, functionName, args) {
  return { address: connection.address, abi: floatAbi, functionName, args };
}

// Collects a problem when value is outside [1, max], as the contract requires.
function within(problems, flag, value, max, source) {
  if (value === 0n || value > max) problems.push(`--${flag} ${value} must be between 1 and ${source} ${max}`);
}

function providerProblems(problems, connection, provider) {
  if (provider === zeroAddress || isAddressEqual(provider, connection.address)) {
    problems.push("--provider must not be the zero address or the Float itself");
  }
}

// The contract accepts any window in [minimum, maximum], but an intent must
// stay executable for its whole signature validity (dueAt >= signatureExpiry +
// minimum and dueAt <= build time + window), so a window shorter than minimum
// plus the default signature validity leaves a line nobody can draw on with
// default settings.
function windowProblems(problems, window, minimum, maximum) {
  if (window < minimum || window > maximum) {
    problems.push(`--max-repayment-window ${window} must be between minimumRepaymentWindow ${minimum} and maximumRepaymentWindow ${maximum}`);
  } else if (window < minimum + DEFAULT_SIGNATURE_TTL) {
    problems.push(
      `--max-repayment-window ${window} must be at least minimumRepaymentWindow ${minimum} + the default ${DEFAULT_SIGNATURE_TTL}s signature validity (${minimum + DEFAULT_SIGNATURE_TTL}): the contract accepts a shorter window, but no intent built with the default --signature-ttl could then be drawn on the line`,
    );
  }
}

// The contract only needs an expiry after the latest block. An intent built now
// with the default signature validity needs a dueAt in [now + that validity +
// minimum, line expiry], so an earlier line expiry leaves a line nobody can draw
// on with default settings. build and sign refuse an intent whose signature
// outlives its provider policy, so an earlier policy expiry leaves less than
// minimumRepaymentWindow in which to build one for that provider.
function expiryProblems(problems, flag, expiry, now, minimum) {
  const floor = now + minimum + DEFAULT_SIGNATURE_TTL;
  if (expiry >= floor) return;
  const consequence =
    flag === "line-expiry"
      ? "no intent built with the default --signature-ttl could then be drawn on the line"
      : "build and sign refuse an intent whose signature outlives the provider policy, so that would leave less than minimumRepaymentWindow to build one with the default --signature-ttl";
  problems.push(
    `--${flag} ${expiry} must be at least the latest block ${now} + minimumRepaymentWindow ${minimum} + the default ${DEFAULT_SIGNATURE_TTL}s signature validity (${floor}): the contract accepts an earlier expiry, but ${consequence}`,
  );
}

// The signer must be the line's sponsor; states lists what the action accepts.
async function sponsorLine(values, mode, lineId, states, action) {
  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);
  const block = await latestBlock(connection);
  const line = await readLine(connection, lineId, block.number);
  if (!isAddressEqual(line.sponsor, signer.address)) {
    throw new Error(`${signer.address} is not the sponsor of line ${lineId} (sponsor is ${line.sponsor})`);
  }
  if (!states.includes(stateName(line))) {
    throw new Error(`line ${lineId} is ${stateName(line)}; ${action} needs ${states.join(" or ")}`);
  }
  return { connection, signer, block, line };
}

async function lineAfter(connection, result, lineId) {
  return readLine(connection, lineId, result.events.at(-1).blockNumber);
}

async function open(values) {
  const agent = addressFlag(values, "agent");
  const provider = addressFlag(values, "provider");
  const endpointHash = endpointFlag(values);
  const reserve = uintFlag(values, "reserve");
  const lineSpendCap = uintFlag(values, "line-spend-cap");
  const dailySpendCap = uintFlag(values, "daily-cap");
  const lineExpiryAt = timeFlag(values, "line-expiry");
  const maximumRepaymentWindow = durationFlag(values, "max-repayment-window");
  const providerPerSpendCap = uintFlag(values, "provider-per-spend");
  const providerDailyCap = uintFlag(values, "provider-daily");
  const providerExpiryAt = timeFlag(values, "provider-expiry");
  const mode = writeMode(values);

  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);
  const sponsor = signer.address;
  const block = await latestBlock(connection);
  const lineExpiry = lineExpiryAt(block.timestamp);
  const providerExpiry = providerExpiryAt(block.timestamp);
  const at = (functionName, args) => read(connection, functionName, args, block.number);
  const [allowed, openingsPaused, previousId, lastEpoch, limits, committed, minimumWindow, maximumWindow] = await Promise.all([
    at("sponsorAllowed", [sponsor]),
    at("openingsPaused"),
    at("activeLineId", [sponsor, agent]),
    at("nextLineEpoch", [sponsor, agent]),
    readLimits(connection, block.number),
    at("totalCommittedCapital"),
    at("minimumRepaymentWindow"),
    at("maximumRepaymentWindow"),
  ]);
  const funding = await usdcFunding(connection, sponsor, reserve);

  const problems = [];
  if (!allowed) problems.push(`sponsor ${sponsor} is not allowlisted; ask the owner to run allow-sponsor --sponsor ${sponsor}`);
  if (openingsPaused) problems.push("openings are paused by the owner");
  if (previousId !== zeroHash) {
    const prior = stateName(await readLine(connection, previousId, block.number));
    if (prior !== "CLOSED" && prior !== "DEFAULTED") {
      problems.push(`line ${previousId} for this sponsor and agent is ${prior}; it must be CLOSED or DEFAULTED before another opens`);
    }
  }
  if (agent === zeroAddress) problems.push("--agent must not be the zero address");
  providerProblems(problems, connection, provider);
  if (endpointHash === zeroHash) problems.push("the endpoint hash must not be zero");
  within(problems, "reserve", reserve, limits.lineReserve, "effectiveLimits.lineReserve");
  if (committed + reserve > limits.protocolReserve) {
    problems.push(`--reserve ${reserve} would take totalCommittedCapital ${committed} past effectiveLimits.protocolReserve ${limits.protocolReserve}`);
  }
  within(problems, "line-spend-cap", lineSpendCap, limits.lineSpend, "effectiveLimits.lineSpend");
  within(problems, "daily-cap", dailySpendCap, limits.dailySpend, "effectiveLimits.dailySpend");
  within(problems, "provider-per-spend", providerPerSpendCap, limits.perSpend, "effectiveLimits.perSpend");
  within(problems, "provider-daily", providerDailyCap, limits.dailySpend, "effectiveLimits.dailySpend");
  expiryProblems(problems, "line-expiry", lineExpiry, block.timestamp, minimumWindow);
  expiryProblems(problems, "provider-expiry", providerExpiry, block.timestamp, minimumWindow);
  windowProblems(problems, maximumRepaymentWindow, minimumWindow, maximumWindow);
  if (funding.balance < reserve) problems.push(`USDC balance ${funding.balance} of ${sponsor} is below --reserve ${reserve}`);
  failIf(problems);

  // lineId = keccak256(abi.encode(chainid, address(this), sponsor, agent, epoch)), as in openLine.
  const epoch = lastEpoch + 1n;
  const lineId = keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, address, address, address, uint64"), [
      connection.chainId,
      connection.address,
      sponsor,
      agent,
      epoch,
    ]),
  );
  const params = {
    agent,
    reserve,
    lineSpendCap,
    dailySpendCap,
    lineExpiry,
    maximumRepaymentWindow,
    provider,
    endpointHash,
    providerPerSpendCap,
    providerDailyCap,
    providerExpiry,
  };
  const calls = [funding.approval, floatCall(connection, "openLine", [params])].filter(Boolean);
  const result = await runCalls(connection, signer, calls);
  const summary = { sponsor, agent, provider, endpointHash, reserve, epoch, lineId, approvalIncluded: funding.approval !== null };
  if (mode.mode !== "execute") return { ...result, ...summary };

  return afterSend({ ...result, ...summary }, async () => {
    const opened = result.events.find((entry) => entry.event === "LineOpened");
    const active = await read(connection, "activeLineId", [sponsor, agent], opened?.blockNumber);
    if (opened?.args.lineId !== lineId || active !== lineId) {
      throw new Error(`LineOpened ${opened?.args.lineId}, activeLineId ${active} and the expected ${lineId} disagree`);
    }
    return {
      epoch: opened.args.epoch,
      termsVersion: opened.args.termsVersion,
      termsHash: await read(connection, "currentTermsHash", [lineId, provider], opened.blockNumber),
    };
  });
}

// Any provider-policy or terms change bumps termsVersion, which is part of every
// provider's currentTermsHash on the line.
function termsVersion(mode, result, line, eventName) {
  const before = line.termsVersion;
  const after = mode.mode === "execute" ? result.events.find((entry) => entry.event === eventName).args.termsVersion : before + 1n;
  return { before, after };
}

// --inactive needs none of the endpoint, cap and expiry flags: any it is not
// given keep the provider's stored policy values.
async function setProviderPolicy(values) {
  const lineId = bytes32Flag(values, "line-id");
  const provider = addressFlag(values, "provider");
  const active = values.inactive !== true;
  const given = (...names) => active || names.some((name) => values[name] !== undefined);
  const endpointHash = given("endpoint", "endpoint-hash") ? endpointFlag(values) : null;
  const perSpendCap = given("per-spend") ? uintFlag(values, "per-spend") : null;
  const dailySpendCap = given("daily") ? uintFlag(values, "daily") : null;
  const expiryAt = given("expiry") ? timeFlag(values, "expiry") : null;
  const mode = writeMode(values);

  const { connection, signer, block, line } = await sponsorLine(values, mode, lineId, ["OPEN", "DRAWN"], "set-provider-policy");
  const stored = active ? null : await readPolicy(connection, lineId, provider, block.number);
  const policy = {
    endpointHash: endpointHash ?? stored.endpointHash,
    perSpendCap: perSpendCap ?? stored.perSpendCap,
    dailySpendCap: dailySpendCap ?? stored.dailySpendCap,
    expiry: expiryAt ? expiryAt(block.timestamp) : stored.expiry,
  };
  const problems = [];
  providerProblems(problems, connection, provider);
  if (active) {
    const [limits, minimumWindow] = await Promise.all([
      readLimits(connection, block.number),
      read(connection, "minimumRepaymentWindow", [], block.number),
    ]);
    if (policy.endpointHash === zeroHash) problems.push("the endpoint hash must not be zero for an active policy");
    within(problems, "per-spend", policy.perSpendCap, limits.perSpend, "effectiveLimits.perSpend");
    within(problems, "daily", policy.dailySpendCap, limits.dailySpend, "effectiveLimits.dailySpend");
    expiryProblems(problems, "expiry", policy.expiry, block.timestamp, minimumWindow);
  }
  failIf(problems);

  const result = await runCalls(connection, signer, [
    floatCall(connection, "setProviderPolicy", [
      lineId,
      provider,
      policy.endpointHash,
      policy.perSpendCap,
      policy.dailySpendCap,
      policy.expiry,
      active,
    ]),
  ]);
  const output = { ...result, invalidatesOutstandingSignatures: true, lineId, provider, ...policy, active };
  if (mode.mode !== "execute") return { ...output, termsVersion: termsVersion(mode, result, line, "ProviderPolicySet") };
  return afterSend(output, async () => ({
    termsVersion: termsVersion(mode, result, line, "ProviderPolicySet"),
    termsHash: await read(connection, "currentTermsHash", [lineId, provider], result.events.at(-1).blockNumber),
  }));
}

async function updateTerms(values) {
  const lineId = bytes32Flag(values, "line-id");
  const lineSpendCap = uintFlag(values, "line-spend-cap");
  const dailySpendCap = uintFlag(values, "daily-cap");
  const lineExpiryAt = timeFlag(values, "line-expiry");
  const maximumRepaymentWindow = durationFlag(values, "max-repayment-window");
  const mode = writeMode(values);

  const { connection, signer, block, line } = await sponsorLine(values, mode, lineId, ["OPEN", "DRAWN"], "update-terms");
  const lineExpiry = lineExpiryAt(block.timestamp);
  const [limits, minimumWindow, maximumWindow] = await Promise.all([
    readLimits(connection, block.number),
    read(connection, "minimumRepaymentWindow"),
    read(connection, "maximumRepaymentWindow"),
  ]);
  const problems = [];
  within(problems, "line-spend-cap", lineSpendCap, limits.lineSpend, "effectiveLimits.lineSpend");
  within(problems, "daily-cap", dailySpendCap, limits.dailySpend, "effectiveLimits.dailySpend");
  expiryProblems(problems, "line-expiry", lineExpiry, block.timestamp, minimumWindow);
  windowProblems(problems, maximumRepaymentWindow, minimumWindow, maximumWindow);
  failIf(problems);

  const result = await runCalls(connection, signer, [
    floatCall(connection, "updateLineTerms", [lineId, lineSpendCap, dailySpendCap, lineExpiry, maximumRepaymentWindow]),
  ]);
  const output = { ...result, invalidatesOutstandingSignatures: true, lineId, lineSpendCap, dailySpendCap, lineExpiry, maximumRepaymentWindow };
  if (mode.mode !== "execute") return { ...output, termsVersion: termsVersion(mode, result, line, "LineTermsUpdated") };
  return afterSend(output, async () => ({ termsVersion: termsVersion(mode, result, line, "LineTermsUpdated") }));
}

async function close(values) {
  const lineId = bytes32Flag(values, "line-id");
  const mode = writeMode(values);
  const { connection, signer, line } = await sponsorLine(values, mode, lineId, ["OPEN"], "close");
  const result = await runCalls(connection, signer, [floatCall(connection, "closeLine", [lineId])]);
  if (mode.mode !== "execute") return { ...result, lineId, amount: line.availableReserve };
  return afterSend({ ...result, lineId }, async () => ({
    amount: result.events.find((entry) => entry.event === "LineClosed").args.amount,
    state: stateName(await lineAfter(connection, result, lineId)),
  }));
}

// --calldata may prepare the call before dueAt for a Safe to send once the line
// is due; it is not simulated then, since it reverts TooEarly until executableAt.
async function declareDefault(values) {
  const lineId = bytes32Flag(values, "line-id");
  const mode = writeMode(values);
  const { connection, signer, block, line } = await sponsorLine(values, mode, lineId, ["DRAWN"], "declare-default");
  const early = block.timestamp < line.dueAt;
  if (early && mode.mode !== "calldata") {
    throw new Error(
      `line ${lineId} is not due: dueAt ${line.dueAt}, latest block ${block.timestamp}, ${line.dueAt - block.timestamp} seconds remaining; --calldata --from <sponsor> prepares the call now`,
    );
  }
  const result = await runCalls(connection, signer, [floatCall(connection, "declareDefault", [lineId])], { simulate: !early });
  const output = { ...result, lineId, principalOutstanding: line.principalOutstanding, dueAt: line.dueAt };
  if (mode.mode === "calldata") return { ...output, executableAt: line.dueAt, simulated: !early };
  if (mode.mode !== "execute") return output;
  return afterSend(output, async () => ({ state: stateName(await lineAfter(connection, result, lineId)) }));
}

async function claimDefaulted(values) {
  const lineId = bytes32Flag(values, "line-id");
  const mode = writeMode(values);
  const { connection, signer, line } = await sponsorLine(values, mode, lineId, ["DEFAULTED"], "claim-defaulted");
  const claimable = line.availableReserve + line.recoveryAvailable;
  if (claimable === 0n) {
    throw new Error(
      `nothing to claim until repayment arrives: line ${lineId} has no available reserve or recovery (principalOutstanding ${line.principalOutstanding})`,
    );
  }
  const result = await runCalls(connection, signer, [floatCall(connection, "claimDefaulted", [lineId])]);
  if (mode.mode !== "execute") return { ...result, lineId, amount: claimable };
  return afterSend({ ...result, lineId }, async () => {
    const after = await lineAfter(connection, result, lineId);
    return {
      amount: result.events.find((entry) => entry.event === "SponsorClaimed").args.amount,
      state: stateName(after),
      principalOutstanding: after.principalOutstanding,
    };
  });
}

const ENDPOINT_OPTIONS = { endpoint: { type: "string" }, "endpoint-hash": { type: "string" } };
const LINE_OPTIONS = { ...WRITE_OPTIONS, "line-id": { type: "string" } };
const COMMANDS = {
  open: {
    options: {
      ...WRITE_OPTIONS,
      ...ENDPOINT_OPTIONS,
      agent: { type: "string" },
      provider: { type: "string" },
      reserve: { type: "string" },
      "line-spend-cap": { type: "string" },
      "daily-cap": { type: "string" },
      "line-expiry": { type: "string" },
      "max-repayment-window": { type: "string" },
      "provider-per-spend": { type: "string" },
      "provider-daily": { type: "string" },
      "provider-expiry": { type: "string" },
    },
    run: open,
  },
  "set-provider-policy": {
    options: {
      ...LINE_OPTIONS,
      ...ENDPOINT_OPTIONS,
      provider: { type: "string" },
      "per-spend": { type: "string" },
      daily: { type: "string" },
      expiry: { type: "string" },
      inactive: { type: "boolean" },
    },
    run: setProviderPolicy,
  },
  "update-terms": {
    options: {
      ...LINE_OPTIONS,
      "line-spend-cap": { type: "string" },
      "daily-cap": { type: "string" },
      "line-expiry": { type: "string" },
      "max-repayment-window": { type: "string" },
    },
    run: updateTerms,
  },
  close: { options: LINE_OPTIONS, run: close },
  "declare-default": { options: LINE_OPTIONS, run: declareDefault },
  "claim-defaulted": { options: LINE_OPTIONS, run: claimDefaulted },
};
const TOOL = "node app/scripts/float-mainnet-sponsor.mjs";
const WRITE = "[--execute | --calldata --from <sponsor>] [--manifest <path>]";
const USAGE = [
  `${TOOL} open --agent <addr> --provider <addr> (--endpoint <s> | --endpoint-hash <bytes32>) --reserve <n> --line-spend-cap <n> --daily-cap <n> --line-expiry <t> --max-repayment-window <seconds> --provider-per-spend <n> --provider-daily <n> --provider-expiry <t> ${WRITE}`,
  `${TOOL} set-provider-policy --line-id <bytes32> --provider <addr> (--endpoint <s> | --endpoint-hash <bytes32>) --per-spend <n> --daily <n> --expiry <t> ${WRITE}`,
  `${TOOL} set-provider-policy --line-id <bytes32> --provider <addr> --inactive [--endpoint <s> | --endpoint-hash <bytes32>] [--per-spend <n>] [--daily <n>] [--expiry <t>] ${WRITE}`,
  `${TOOL} update-terms --line-id <bytes32> --line-spend-cap <n> --daily-cap <n> --line-expiry <t> --max-repayment-window <seconds> ${WRITE}`,
  `${TOOL} close --line-id <bytes32> ${WRITE}`,
  `${TOOL} declare-default --line-id <bytes32> ${WRITE}`,
  `${TOOL} claim-defaulted --line-id <bytes32> ${WRITE}`,
  `Amounts are atomic USDC; <t> is unix seconds or +<seconds> after the latest block. --max-repayment-window must be at least the contract's minimumRepaymentWindow + ${DEFAULT_SIGNATURE_TTL}s, and --line-expiry, --provider-expiry and an active policy's --expiry at least the latest block + minimumRepaymentWindow + ${DEFAULT_SIGNATURE_TTL}s. --inactive keeps every stored policy value it is not given. declare-default --calldata also works before dueAt and reports executableAt.`,
  `Signs with ${KEY} (never printed); without --execute it only simulates. --calldata --from <sponsor> needs no key.`,
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
