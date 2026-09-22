import { zeroAddress } from "viem";
import { floatAbi } from "./float-mainnet-config.mjs";
import { WRITE_OPTIONS, afterSend, bytes32Flag, connect, read, runCalls, runCli, signerFor, uintFlag, writeMode } from "./float-mainnet-cli.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";

// The agent voids a nonce so that no intent signed with it can execute. A
// smart-account agent (no raw key) prints the call with --calldata --from.

const KEY = "FLOAT_AGENT_PRIVATE_KEY";

async function cancelNonce(values) {
  const lineId = bytes32Flag(values, "line-id");
  const nonce = uintFlag(values, "nonce");
  const mode = writeMode(values);
  const connection = await connect(values);
  const signer = signerFor(connection, mode, KEY);

  const [line, used, cancelled] = await Promise.all([
    read(connection, "getLine", [lineId]),
    read(connection, "nonceUsed", [lineId, nonce]),
    read(connection, "nonceCancelled", [lineId, nonce]),
  ]);
  if (line.agent === zeroAddress) throw new Error(`no line ${lineId}`);
  if (line.agent !== signer.address) {
    const who = mode.mode === "calldata" ? "--from is" : `${KEY} belongs to`;
    throw new Error(`${who} ${signer.address}; only the line's agent ${line.agent} can cancel its nonces`);
  }
  if (used) throw new Error(`nonce ${nonce} on line ${lineId} is already used; there is nothing to cancel`);
  if (cancelled) throw new Error(`nonce ${nonce} on line ${lineId} is already cancelled`);

  const result = await runCalls(connection, signer, [
    { address: connection.address, abi: floatAbi, functionName: "cancelNonce", args: [lineId, nonce] },
  ]);
  if (mode.mode !== "execute") return { ...result, lineId, nonce };
  return afterSend({ ...result, lineId, nonce }, async () => ({
    nonceCancelled: await read(connection, "nonceCancelled", [lineId, nonce], result.events.at(-1).blockNumber),
  }));
}

const COMMANDS = {
  "cancel-nonce": {
    options: { ...WRITE_OPTIONS, "line-id": { type: "string" }, nonce: { type: "string" } },
    run: cancelNonce,
  },
};
const USAGE = [
  "node app/scripts/float-mainnet-cancel-nonce.mjs --line-id <bytes32> --nonce <n> [--execute | --calldata --from <agent>] [--manifest <path>]",
  `Signs with ${KEY} (never printed); without --execute it only simulates. --calldata --from <agent> needs no key and prints the cancelNonce call for a smart-account agent.`,
];

// A single-purpose tool: it takes the flags directly, with no command word.
if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE, ["cancel-nonce", ...process.argv.slice(2)]);
