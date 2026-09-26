import { isAddressEqual, zeroAddress } from "viem";
import { floatAbi } from "./float-mainnet-config.mjs";
import { WRITE_OPTIONS, UsageError, addressFlag, connect, read, runCalls, runCli, signerFor, uintFlag, writeMode } from "./float-mainnet-cli.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";

// Owner and emergency-operator actions on the ShadowFloatMainnet candidate.
// --calldata --from <address> prepares a call without a key, including for an
// owner Safe. The testnet owner is an EOA; these tools do not certify Safe setup.

const KEY = "FLOAT_OWNER_PRIVATE_KEY";
const PAUSE_FUNCTIONS = { openings: "setOpeningsPaused", spends: "setSpendsPaused" };
// Exact CapKind order in ShadowFloatMainnet.sol; require names instead of raw
// enum numbers so the reviewed output identifies the limit being changed.
const CAP_NAMES = ["protocol-reserve", "line-reserve", "line-spend", "per-spend", "daily-spend"];

// An operator may pause; only the owner may unpause or change the allowlist.
async function authorize(connection, signer, { operatorMayAct }) {
  const owner = await read(connection, "owner");
  if (isAddressEqual(signer.address, owner)) return;
  if (operatorMayAct && (await read(connection, "operators", [signer.address]))) return;
  const role = operatorMayAct ? "owner() or an operator" : "owner()";
  throw new Error(`${signer.address} is not ${role} of ${connection.address} (owner is ${owner})`);
}

async function setSponsor(values, allowed) {
  const sponsor = addressFlag(values, "sponsor");
  const mode = writeMode(values);
  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);
  await authorize(connection, signer, { operatorMayAct: false });
  const allowedBefore = await read(connection, "sponsorAllowed", [sponsor]);
  const result = await runCalls(connection, signer, [
    { address: connection.address, abi: floatAbi, functionName: "setSponsorAllowed", args: [sponsor, allowed] },
  ]);
  return { ...result, sponsor, allowedBefore, allowed };
}

async function setPaused(values, paused) {
  const what = values.what;
  if (!Object.hasOwn(PAUSE_FUNCTIONS, what ?? "")) throw new UsageError("--what must be openings or spends");
  const mode = writeMode(values);
  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);
  await authorize(connection, signer, { operatorMayAct: paused });
  const pausedBefore = await read(connection, what === "openings" ? "openingsPaused" : "spendsPaused");
  const result = await runCalls(connection, signer, [
    { address: connection.address, abi: floatAbi, functionName: PAUSE_FUNCTIONS[what], args: [paused] },
  ]);
  return { ...result, what, pausedBefore, paused };
}

function nonzeroAddress(values, name) {
  const value = addressFlag(values, name);
  if (isAddressEqual(value, zeroAddress)) throw new UsageError(`--${name} must not be the zero address`);
  return value;
}

function capKind(values) {
  const kind = CAP_NAMES.indexOf(values.cap);
  if (kind < 0) throw new UsageError(`--cap must be one of ${CAP_NAMES.join(" | ")}`);
  return kind;
}

async function setOperator(values, allowed) {
  const operator = nonzeroAddress(values, "operator");
  const mode = writeMode(values);
  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);
  await authorize(connection, signer, { operatorMayAct: false });
  const allowedBefore = await read(connection, "operators", [operator]);
  const result = await runCalls(connection, signer, [
    { address: connection.address, abi: floatAbi, functionName: "setOperator", args: [operator, allowed] },
  ]);
  return { ...result, operator, allowedBefore, allowed };
}

async function reduceCap(values) {
  const kind = capKind(values);
  const newValue = uintFlag(values, "value");
  if (newValue === 0n) throw new UsageError("--value must be positive; use pause to stop new risk entirely");
  const mode = writeMode(values);
  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);
  await authorize(connection, signer, { operatorMayAct: false });
  const [limits, pending] = await Promise.all([read(connection, "effectiveLimits"), read(connection, "pendingCaps", [kind])]);
  const oldValue = limits[kind];
  if (newValue > oldValue) throw new Error("reduce-cap cannot increase an effective limit");
  const result = await runCalls(connection, signer, [
    { address: connection.address, abi: floatAbi, functionName: "reduceCap", args: [kind, newValue] },
  ]);
  return { ...result, cap: CAP_NAMES[kind], kind, oldValue, newValue, pendingBefore: { value: pending[0], activateAt: pending[1] } };
}

async function cancelCapIncrease(values) {
  const kind = capKind(values);
  const mode = writeMode(values);
  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);
  await authorize(connection, signer, { operatorMayAct: true });
  const [value, activateAt] = await read(connection, "pendingCaps", [kind]);
  if (activateAt === 0n) throw new Error(`no pending cap increase for ${CAP_NAMES[kind]}`);
  const result = await runCalls(connection, signer, [
    { address: connection.address, abi: floatAbi, functionName: "cancelCapIncrease", args: [kind] },
  ]);
  return { ...result, cap: CAP_NAMES[kind], kind, pendingBefore: { value, activateAt } };
}

async function proposeOwner(values) {
  const proposedOwner = nonzeroAddress(values, "owner");
  const mode = writeMode(values);
  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);
  await authorize(connection, signer, { operatorMayAct: false });
  const pendingOwnerBefore = await read(connection, "pendingOwner");
  const result = await runCalls(connection, signer, [
    { address: connection.address, abi: floatAbi, functionName: "proposeOwner", args: [proposedOwner] },
  ]);
  return { ...result, currentOwner: signer.address, pendingOwnerBefore, proposedOwner };
}

async function acceptOwner(values) {
  const mode = writeMode(values);
  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);
  const [ownerBefore, pendingOwner] = await Promise.all([read(connection, "owner"), read(connection, "pendingOwner")]);
  if (isAddressEqual(pendingOwner, zeroAddress)) throw new Error("no pending ownership proposal");
  if (!isAddressEqual(signer.address, pendingOwner)) throw new Error(`${signer.address} is not pendingOwner() of ${connection.address}`);
  const result = await runCalls(connection, signer, [
    { address: connection.address, abi: floatAbi, functionName: "acceptOwnership", args: [] },
  ]);
  return { ...result, ownerBefore, proposedOwner: pendingOwner };
}

const SPONSOR_OPTIONS = { ...WRITE_OPTIONS, sponsor: { type: "string" } };
const PAUSE_OPTIONS = { ...WRITE_OPTIONS, what: { type: "string" } };
const OPERATOR_OPTIONS = { ...WRITE_OPTIONS, operator: { type: "string" } };
const CAP_OPTIONS = { ...WRITE_OPTIONS, cap: { type: "string" } };
const COMMANDS = {
  "allow-sponsor": { options: SPONSOR_OPTIONS, run: (values) => setSponsor(values, true) },
  "disallow-sponsor": { options: SPONSOR_OPTIONS, run: (values) => setSponsor(values, false) },
  pause: { options: PAUSE_OPTIONS, run: (values) => setPaused(values, true) },
  unpause: { options: PAUSE_OPTIONS, run: (values) => setPaused(values, false) },
  "allow-operator": { options: OPERATOR_OPTIONS, run: (values) => setOperator(values, true) },
  "disallow-operator": { options: OPERATOR_OPTIONS, run: (values) => setOperator(values, false) },
  "reduce-cap": { options: { ...CAP_OPTIONS, value: { type: "string" } }, run: reduceCap },
  "cancel-cap-increase": { options: CAP_OPTIONS, run: cancelCapIncrease },
  "propose-owner": { options: { ...WRITE_OPTIONS, owner: { type: "string" } }, run: proposeOwner },
  "accept-owner": { options: WRITE_OPTIONS, run: acceptOwner },
};
const TOOL = "node app/scripts/float-mainnet-owner.mjs";
const USAGE = [
  `${TOOL} allow-sponsor --sponsor <addr> [--execute | --calldata --from <owner>] [--manifest <path>]`,
  `${TOOL} disallow-sponsor --sponsor <addr> [--execute | --calldata --from <owner>] [--manifest <path>]`,
  `${TOOL} pause --what openings|spends [--execute | --calldata --from <owner or operator>] [--manifest <path>]`,
  `${TOOL} unpause --what openings|spends [--execute | --calldata --from <owner>] [--manifest <path>]`,
  `${TOOL} allow-operator|disallow-operator --operator <addr> [--execute | --calldata --from <owner>] [--manifest <path>]`,
  `${TOOL} reduce-cap --cap <name> --value <atomic USDC> [--execute | --calldata --from <owner>] [--manifest <path>]`,
  `${TOOL} cancel-cap-increase --cap <name> [--execute | --calldata --from <owner or operator>] [--manifest <path>]`,
  `${TOOL} propose-owner --owner <addr> [--execute | --calldata --from <current owner>] [--manifest <path>]`,
  `${TOOL} accept-owner [--execute | --calldata --from <pending owner>] [--manifest <path>]`,
  `Cap names: ${CAP_NAMES.join(" | ")}. Values use six-decimal atomic USDC. Reducing a cap also cancels its queued increase; zero is invalid.`,
  "Ownership proposal does not transfer control. Acceptance must be sent by pendingOwner(); verify the recipient wallet and its governance independently.",
  `Signs with ${KEY} (never printed); without --execute it only simulates. --calldata --from <addr> needs no key and prints the calls for a Safe.`,
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
