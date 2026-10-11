import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { heartbeatStatus, loadContext } from "./float-mainnet-monitor-runner.mjs";

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const requireThat = (condition) => { if (!condition) throw new Error("Provider admission monitor could not be verified"); };

// Pin operator-selected files at startup. A changed release or policy requires
// a deliberate provider restart, not policy learned from the current snapshot.
// This gate has no signing key, writes no monitor state and never affects /serve.
export function createProviderMonitorGuard({ connection, manifestPath, baselinePath, stateDir }) {
  requireThat(connection && manifestPath && baselinePath && stateDir);
  const pinned = loadContext({ manifestPath, baselinePath, stateDir });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const b = pinned.baseline;
  requireThat(b.schemaVersion === 2 && manifest.publicRegistration === true && manifest.repaymentBindingVersion === 2);
  requireThat(String(connection.chainId) === b.identity.chainId && String(manifest.chainId) === b.identity.chainId);
  requireThat(same(connection.address, b.identity.address) && same(manifest.contract?.address, b.identity.address));
  requireThat(same(manifest.bytecode?.onchainRuntimeKeccak256, b.identity.runtimeCodeHash));
  const current = () => {
    const context = loadContext({ manifestPath, baselinePath, stateDir });
    requireThat(context.baselineHash === pinned.baselineHash && context.manifestHash === pinned.manifestHash);
    const status = heartbeatStatus(context);
    requireThat(status.ok === true && status.hold === false && status.status === "healthy" && b.pauses.spendsPaused === false);
    return status;
  };
  return async () => {
    const initial = current();
    const observed = initial.observedAt;
    const blockNumber = BigInt(observed.blockNumber);
    const canonical = async () => {
      const block = await connection.client.getBlock({ blockNumber });
      requireThat(String(block.number) === observed.blockNumber && same(block.hash, observed.blockHash) && String(block.timestamp) === observed.timestamp);
    };
    await canonical();
    const code = await connection.client.getCode({ address: connection.address, blockNumber });
    requireThat(typeof code === "string" && code !== "0x" && same(keccak256(code), b.identity.runtimeCodeHash));
    await canonical();
    const final = current();
    requireThat(final.runId === initial.runId && final.snapshotHash === initial.snapshotHash);
  };
}


// An explicit startup mode avoids silently treating a missing public marker as
// a private deployment. Unmonitored signing is restricted to testnet; all new
// mainnet signing processes require a validated public monitor configuration.
export function configureProviderAdmission({mode, recoveryOnly = false, ...options}) {
  if (recoveryOnly) return null;
  if (mode === "public-monitor") return createProviderMonitorGuard(options);
  if (mode === "testnet-unmonitored" && String(options.connection?.chainId) === "5042002") return null;
  throw new Error("Signing requires PROVIDER_ADMISSION_MODE=public-monitor with bound monitor configuration; testnet may explicitly select testnet-unmonitored");
}
