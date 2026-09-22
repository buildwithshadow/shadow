import { isAddressEqual } from "viem";
import { floatAbi } from "./float-mainnet-config.mjs";
import { WRITE_OPTIONS, UsageError, addressFlag, connect, read, runCalls, runCli, signerFor, writeMode } from "./float-mainnet-cli.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";

// Owner actions on the ShadowFloatMainnet candidate. On the real deployment the
// owner is a Safe, so every command also prints unsigned calldata with
// --calldata --from <safe>.

const KEY = "FLOAT_OWNER_PRIVATE_KEY";
const PAUSE_FUNCTIONS = { openings: "setOpeningsPaused", spends: "setSpendsPaused" };

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

const SPONSOR_OPTIONS = { ...WRITE_OPTIONS, sponsor: { type: "string" } };
const PAUSE_OPTIONS = { ...WRITE_OPTIONS, what: { type: "string" } };
const COMMANDS = {
  "allow-sponsor": { options: SPONSOR_OPTIONS, run: (values) => setSponsor(values, true) },
  "disallow-sponsor": { options: SPONSOR_OPTIONS, run: (values) => setSponsor(values, false) },
  pause: { options: PAUSE_OPTIONS, run: (values) => setPaused(values, true) },
  unpause: { options: PAUSE_OPTIONS, run: (values) => setPaused(values, false) },
};
const TOOL = "node app/scripts/float-mainnet-owner.mjs";
const USAGE = [
  `${TOOL} allow-sponsor --sponsor <addr> [--execute | --calldata --from <owner>] [--manifest <path>]`,
  `${TOOL} disallow-sponsor --sponsor <addr> [--execute | --calldata --from <owner>] [--manifest <path>]`,
  `${TOOL} pause --what openings|spends [--execute | --calldata --from <owner or operator>] [--manifest <path>]`,
  `${TOOL} unpause --what openings|spends [--execute | --calldata --from <owner>] [--manifest <path>]`,
  `Signs with ${KEY} (never printed); without --execute it only simulates. --calldata --from <addr> needs no key and prints the calls for a Safe.`,
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
