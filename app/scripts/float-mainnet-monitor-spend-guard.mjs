import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256 } from "viem";
import { floatAbi } from "./float-mainnet-config.mjs";
import { digestJson } from "./float-mainnet-monitor-policy.mjs";
import { heartbeatStatus, loadContext } from "./float-mainnet-monitor-runner.mjs";

class MonitorGuardError extends Error {}
const fail = (detail) => { throw new MonitorGuardError(`spend monitor: ${detail}`); };
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const requireThat = (condition, detail) => { if (!condition) fail(detail); };

// Call immediately before reservation and again before broadcast. This is a
// read-only permission gate, not a ledger initializer, monitor installer or
// replacement for current onchain simulation and receipt/nonce reconciliation.
export async function assertHealthySpendMonitor({ baselinePath, manifestPath, stateDir, sessionPolicy, connection, struct }) {
  try {
    requireThat(baselinePath && manifestPath && stateDir && sessionPolicy && connection && struct, "baseline, manifest, state directory, session policy, connection and exact intent are required");
    const context = loadContext({ baselinePath, manifestPath, stateDir });
    const b = context.baseline;
    const initial = heartbeatStatus(context);
    requireThat(initial.ok === true && initial.hold === false && initial.status === "healthy", "fresh healthy heartbeat required; monitoring is missing, held, stale or invalid");
    requireThat(String(connection.chainId) === b.identity.chainId && String(sessionPolicy.chainId) === b.identity.chainId, "chain identity differs from the approved monitor baseline");
    requireThat(same(connection.address, b.identity.address) && same(sessionPolicy.verifyingContract, b.identity.address), "contract identity differs from the approved monitor baseline");
    requireThat(same(sessionPolicy.runtimeKeccak256, b.identity.runtimeCodeHash), "runtime identity differs from the approved monitor baseline");
    requireThat(b.pauses.openingsPaused === true && b.pauses.spendsPaused === false, "baseline does not approve the spend-enabled phase with openings paused");
    for (const field of ["executor", "sponsor", "agent", "provider", "endpointHash"]) requireThat(same(struct[field], sessionPolicy[field]), `intent ${field} differs from the execution session policy`);
    requireThat(same(struct.executor, b.executor.address), "executor differs from the approved monitor baseline");
    requireThat(b.sponsors.some((sponsor) => same(sponsor, struct.sponsor)), "sponsor is not approved by the monitor baseline");
    const line = b.lines.find((entry) => same(entry.lineId, struct.lineId));
    requireThat(line && line.allowedStates.includes("OPEN"), "intent line is missing or OPEN is not approved");
    requireThat(String(struct.lineEpoch) === line.epoch && same(line.sponsor, struct.sponsor) && same(line.agent, struct.agent), "intent epoch or line parties differ from the approved baseline");
    const provider = line.providers.find((entry) => same(entry.provider, struct.provider));
    requireThat(provider?.active === true && same(provider.endpointHash, struct.endpointHash), "active provider/endpoint is not approved for this line");
    const snapshot = JSON.parse(readFileSync(resolve(context.stateDir, "snapshot.json"), "utf8"));
    requireThat(digestJson(snapshot) === initial.snapshotHash, "snapshot changed while inspecting monitor health");
    const observedLine = snapshot.lines.find((entry) => same(entry.lineId, struct.lineId));
    requireThat(observedLine?.state === "OPEN", "monitor did not observe the intent line OPEN");
    const observed = initial.observedAt;
    const blockNumber = BigInt(observed.blockNumber);
    const canonical = async () => {
      const block = await connection.client.getBlock({ blockNumber });
      requireThat(String(block.number) === observed.blockNumber && same(block.hash, observed.blockHash) && String(block.timestamp) === observed.timestamp, "heartbeat observed block is no longer canonical on the execution RPC");
    };
    requireThat(String(await connection.client.getChainId()) === b.identity.chainId, "execution RPC chain differs from the approved baseline");
    await canonical();
    const code = await connection.client.getCode({ address: connection.address, blockNumber });
    requireThat(typeof code === "string" && code !== "0x" && same(keccak256(code), b.identity.runtimeCodeHash), "pinned contract runtime differs from the approved baseline");
    const usdc = await connection.client.readContract({ address: connection.address, abi: floatAbi, functionName: "usdc", blockNumber });
    requireThat(same(usdc, b.identity.usdc), "pinned USDC identity differs from the approved baseline");
    if (sessionPolicy.usdc !== undefined) requireThat(same(sessionPolicy.usdc, b.identity.usdc), "session USDC identity differs from the approved baseline");
    await canonical();
    // RPC reads take time. A monitor hold, new cycle, changed file or stale
    // observation during those reads must revoke this attempt as well.
    const finalContext = loadContext({ baselinePath, manifestPath, stateDir });
    requireThat(finalContext.baselineHash === context.baselineHash && finalContext.manifestHash === context.manifestHash, "approved baseline or manifest changed during the guard");
    const final = heartbeatStatus(finalContext);
    requireThat(final.ok === true && final.hold === false && final.status === "healthy" && final.runId === initial.runId && final.snapshotHash === initial.snapshotHash, "monitor changed, became held or expired during the guard; obtain a fresh check");
    return { kind: "ShadowFloatMainnet.SpendMonitorProof", runId: final.runId, baselineHash: context.baselineHash, manifestHash: context.manifestHash,
      snapshotHash: final.snapshotHash, completedAt: final.completedAt, observedAt: final.observedAt, lineId: line.lineId, lineEpoch: line.epoch, executor: b.executor.address };
  } catch (error) {
    if (error instanceof MonitorGuardError) throw error;
    // Do not expose provider URLs, credentials, request bodies or local file contents.
    fail("local monitor state or pinned chain reads could not be verified");
  }
}
