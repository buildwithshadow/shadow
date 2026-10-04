import { floatAbi } from "./float-mainnet-config.mjs";
import { parseAbi } from "viem";
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
  const expectedDraw = values["expected-draw"] === undefined ? null : bytes32Flag(values, "expected-draw");
  if (expectedDraw && values["allow-current-line-debt"]) throw new UsageError("purchase-bound repayment and generic-current-debt consent are mutually exclusive");
  if (!expectedDraw && !values["allow-current-line-debt"]) throw new UsageError("pass --expected-draw <purchase digest> for guarded repayment; legacy V1 repayment requires --allow-current-line-debt and can settle a newer purchase after a delayed approval");
  if ((values.amount === undefined) === (values.full !== true)) throw new UsageError("pass --amount <n> or --full");
  const requested = values.full ? null : uintFlag(values, "amount");
  const mode = writeMode(values);

  const connection = await connect(values);
  const keyEnv = mode.mode === "calldata" ? null : repayerKey();
  const signer = signerFor(connection, mode, keyEnv);
  const block = await latestBlock(connection);
  const line = await readLine(connection, lineId, block.number);
  const guardedAbi = parseAbi(["function repaymentBindingVersion() view returns (uint256)", "function currentDrawDigest(bytes32) view returns (bytes32)", "function repayForDraw(bytes32,bytes32,uint256)"]);
  if (expectedDraw) {
    const at = (functionName, args = []) => connection.client.readContract({ address: connection.address, abi: guardedAbi, functionName, args, blockNumber: block.number });
    if (await at("repaymentBindingVersion") !== 2n || (await at("currentDrawDigest", [lineId])).toLowerCase() !== expectedDraw.toLowerCase()) throw new Error("the reviewed purchase is not the current draw on a guarded contract; no repayment or approval was prepared");
  }
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
    expectedDraw
      ? { address: connection.address, abi: guardedAbi, functionName: "repayForDraw", args: [lineId, expectedDraw, amount] }
      : { address: connection.address, abi: floatAbi, functionName: "repay", args: [lineId, amount] },
  ].filter(Boolean);
  const result = await runCalls(connection, signer, calls);
  const output = {
    ...result,
    lineId,
    repayer: signer.address,
    keyEnv,
    amount,
    expectedDraw,
    consent: expectedDraw ? "reviewed-purchase-only" : "any-current-line-debt-at-execution",
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
    options: { ...WRITE_OPTIONS, "line-id": { type: "string" }, "expected-draw": { type: "string" }, "allow-current-line-debt": { type: "boolean" }, amount: { type: "string" }, full: { type: "boolean" } },
    run: repay,
  },
};
const USAGE = [
  "node app/scripts/float-mainnet-repay.mjs --line-id <bytes32> (--expected-draw <purchase digest> | --allow-current-line-debt) (--amount <n> | --full) [--execute | --calldata --from <payer>] [--manifest <path>]",
  "Amounts are atomic USDC. Signs with FLOAT_REPAYER_PRIVATE_KEY, or FLOAT_AGENT_PRIVATE_KEY when that is unset (never printed); without --execute it only simulates. --calldata --from <payer> needs no key.",
];

// A single-purpose tool: it takes the flags directly, with no command word.
if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE, ["repay", ...process.argv.slice(2)]);
