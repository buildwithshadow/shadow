import { floatAbi } from "./float-mainnet-config.mjs";
import {
  WRITE_OPTIONS,
  UsageError,
  afterSend,
  bytes32Flag,
  connect,
  failIf,
  latestBlock,
  readLine,
  runCalls,
  runCli,
  signerFor,
  stateName,
  uintFlag,
  usdcFunding,
  writeMode,
} from "./float-mainnet-cli.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";

// Repays a DRAWN or DEFAULTED line on the ShadowFloatMainnet candidate. Anyone
// may repay; a repayment on a DEFAULTED line becomes sponsor recovery and never
// reopens the line.

// The agent usually repays its own debt, so its key is the fallback.
function repayerKey(env = process.env) {
  if (env.FLOAT_REPAYER_PRIVATE_KEY?.trim()) return "FLOAT_REPAYER_PRIVATE_KEY";
  if (env.FLOAT_AGENT_PRIVATE_KEY?.trim()) return "FLOAT_AGENT_PRIVATE_KEY";
  throw new Error("FLOAT_REPAYER_PRIVATE_KEY, or FLOAT_AGENT_PRIVATE_KEY when the agent repays, is required to sign");
}

async function repay(values) {
  const lineId = bytes32Flag(values, "line-id");
  if ((values.amount === undefined) === (values.full !== true)) throw new UsageError("pass --amount <n> or --full");
  const requested = values.full ? null : uintFlag(values, "amount");
  const mode = writeMode(values);

  const connection = await connect(values);
  const keyEnv = mode.mode === "calldata" ? null : repayerKey();
  const signer = signerFor(connection, mode, keyEnv);
  const block = await latestBlock(connection);
  const line = await readLine(connection, lineId, block.number);
  const state = stateName(line);
  const amount = requested ?? line.principalOutstanding;
  const funding = await usdcFunding(connection, signer.address, amount);

  const problems = [];
  if (state !== "DRAWN" && state !== "DEFAULTED") problems.push(`line ${lineId} is ${state}; only a DRAWN or DEFAULTED line takes repayment`);
  else if (amount === 0n || amount > line.principalOutstanding) {
    problems.push(`--amount ${amount} must be between 1 and principalOutstanding ${line.principalOutstanding}`);
  }
  if (funding.balance < amount) problems.push(`USDC balance ${funding.balance} of ${signer.address} is below the repayment ${amount}`);
  failIf(problems);

  const calls = [
    funding.approval,
    { address: connection.address, abi: floatAbi, functionName: "repay", args: [lineId, amount] },
  ].filter(Boolean);
  const result = await runCalls(connection, signer, calls);
  const output = {
    ...result,
    lineId,
    repayer: signer.address,
    keyEnv,
    amount,
    approvalIncluded: funding.approval !== null,
    before: { state, principalOutstanding: line.principalOutstanding },
  };
  if (mode.mode !== "execute") return output;

  return afterSend(output, async () => {
    const after = await readLine(connection, lineId, result.events.at(-1).blockNumber);
    const summary = { state: stateName(after), principalOutstanding: after.principalOutstanding, availableReserve: after.availableReserve };
    if (stateName(after) === "DEFAULTED") summary.recoveryAvailable = after.recoveryAvailable;
    return { after: summary };
  });
}

const COMMANDS = {
  repay: {
    options: { ...WRITE_OPTIONS, "line-id": { type: "string" }, amount: { type: "string" }, full: { type: "boolean" } },
    run: repay,
  },
};
const USAGE = [
  "node app/scripts/float-mainnet-repay.mjs --line-id <bytes32> (--amount <n> | --full) [--execute | --calldata --from <payer>] [--manifest <path>]",
  "Amounts are atomic USDC. Signs with FLOAT_REPAYER_PRIVATE_KEY, or FLOAT_AGENT_PRIVATE_KEY when that is unset (never printed); without --execute it only simulates. --calldata --from <payer> needs no key.",
];

// A single-purpose tool: it takes the flags directly, with no command word.
if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE, ["repay", ...process.argv.slice(2)]);
