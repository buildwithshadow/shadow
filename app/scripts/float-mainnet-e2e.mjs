import { execFile, spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

// Shared by the float-mainnet end-to-end test suites: a local anvil and a
// participant-CLI runner. Each suite and RPC proxy uses its own port in
// 18561-18579.

const MNEMONIC = "test test test test test test test test test test test junk";
export const CHAIN_ID = 5_042_002n;
const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));

export function account(addressIndex) {
  return mnemonicToAccount(MNEMONIC, { addressIndex });
}

export function keyOf(addressIndex) {
  return toHex(account(addressIndex).getHdKey().privateKey);
}

// PATH first, then ~/.foundry/bin.
function findAnvil() {
  const candidates = ["anvil", join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil")];
  return candidates.find((bin) => spawnSync(bin, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0) ?? null;
}

const ANVIL = findAnvil();
// The describe() skip option: a missing anvil fails the suite (startAnvil
// throws), unless FLOAT_E2E_OPTIONAL=1, when it skips the suite with a message.
export const e2eSkip =
  !ANVIL && process.env.FLOAT_E2E_OPTIONAL === "1"
    ? "anvil not found on PATH or in ~/.foundry/bin, and FLOAT_E2E_OPTIONAL=1 skips this end-to-end suite; install Foundry to run it"
    : false;

async function rpcAnswers(rpc) {
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false; // connection refused: nothing listening yet
  }
}

// Starts anvil on `port` and resolves once it answers; stop() kills it through
// its child-process handle.
export async function startAnvil(port, extraArgs = []) {
  if (!ANVIL) {
    throw new Error("anvil not found on PATH or in ~/.foundry/bin: install Foundry, or set FLOAT_E2E_OPTIONAL=1 to skip the end-to-end suites");
  }
  const rpc = `http://127.0.0.1:${port}`;
  if (await rpcAnswers(rpc)) throw new Error(`${rpc} is already serving JSON-RPC; stop that process before running this test`);
  const child = spawn(ANVIL, ["--chain-id", CHAIN_ID.toString(), "--port", String(port), "--quiet", ...extraArgs], {
    stdio: "ignore",
    windowsHide: true,
  });
  const kill = () => child.kill();
  process.on("exit", kill);
  const stop = () => {
    kill();
    process.off("exit", kill);
  };
  const deadline = Date.now() + 30_000;
  while (!(await rpcAnswers(rpc))) {
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`);
    if (Date.now() > deadline) {
      stop();
      throw new Error(`anvil did not answer on ${rpc} within 30 s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { rpc, stop };
}

// Runs app/scripts/float-mainnet-<tool>.mjs exactly as a participant would: its
// own process, one JSON object on stdout, configuration and keys from env only.
// Every inherited FLOAT_* and ARC_* variable is dropped first, so a key in the
// parent shell can never stand in for one the caller did not pass.
// Asynchronous, so an in-process RPC proxy can keep serving the child.
export function runTool(tool, args, env) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(FLOAT_|ARC_)/i.test(name)));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(SCRIPTS, `float-mainnet-${tool}.mjs`), ...args],
      { env: { ...inherited, ...env }, encoding: "utf8", timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(error);
        const status = error ? error.code : 0;
        try {
          resolve({ status, json: JSON.parse(stdout) });
        } catch {
          reject(new Error(`${tool} ${args[0] ?? ""} did not print one JSON object (exit ${status}):\n${stdout}\n${stderr}`));
        }
      },
    );
  });
}
