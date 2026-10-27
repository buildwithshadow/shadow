import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { heartbeatStatus, loadContext } from "./float-mainnet-monitor-runner.mjs";

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const requireThat = (condition) => { if (!condition) throw new Error("Provider admission monitor could not be verified"); };

// Pin operator-selected files at startup. A changed release or policy requires
// a deliberate provider restart, not policy learned from the current snapshot.
// This gate has no signing key, writes no monitor state and never affects /serve.
function createBoundMonitorGuard({ connection, manifestPath, baselinePath, stateDir }, fixedTestnet) {
  requireThat(connection && manifestPath && baselinePath && stateDir);
  const pinned = loadContext({ manifestPath, baselinePath, stateDir });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const b = pinned.baseline;
  requireThat(manifest.publicRegistration === true && manifest.repaymentBindingVersion === 2);
  if (fixedTestnet) {
    requireThat(b.schemaVersion === 1 && b.identity.chainId === "5042002"
      && manifest.config?.maximumLineLifetime === "604800");
    if (fixedTestnet === "settled") {
      requireThat(manifest.kind === "shadow-public-settled-testnet-release"
        && manifest.contract?.name === "ShadowFloatMainnetPublicSettled"
        && manifest.contract?.accountingModel === "settled-v1" && b.accountingModel === "settled-v1");
    } else {
      requireThat(manifest.kind === "shadow-public-bounded-testnet-release"
        && manifest.contract?.name === "ShadowFloatMainnetPublicBounded");
    }
  } else {
    requireThat(b.schemaVersion === 2 && b.identity.chainId === "5042");
  }
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

export function createProviderMonitorGuard(options) {
  return createBoundMonitorGuard(options, false);
}

// A bounded testnet rehearsal uses an explicit fixed participant/line policy.
// It retains the same heartbeat, hold, canonical-block and runtime checks.
// This mode cannot satisfy or downgrade the public mainnet admission policy.
export function createTestnetProviderMonitorGuard(options) {
  return createBoundMonitorGuard(options, true);
}

export function createSettledTestnetProviderMonitorGuard(options) {
  return createBoundMonitorGuard(options, "settled");
}

// An explicit startup mode avoids silently treating a missing public marker as
// a private deployment. Unmonitored signing is restricted to testnet; all new
// mainnet signing processes require a validated public monitor configuration.
export function configureProviderAdmission({mode, recoveryOnly = false, ...options}) {
  if (recoveryOnly) return null;
  if (mode === "public-monitor") return createProviderMonitorGuard(options);
  if (mode === "testnet-monitor") return createTestnetProviderMonitorGuard(options);
  if (mode === "settled-testnet-monitor") return createSettledTestnetProviderMonitorGuard(options);
  if (mode === "testnet-unmonitored" && String(options.connection?.chainId) === "5042002") return null;
  throw new Error("Signing requires an explicit bound monitor mode; bounded testnet may select testnet-monitor, and other testnet rehearsals may explicitly select testnet-unmonitored");
}
