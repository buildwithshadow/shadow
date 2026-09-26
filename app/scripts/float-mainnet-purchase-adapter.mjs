import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { connectCandidate, readDeployment } from "./float-mainnet-config.mjs";
import { readSessionPolicy, withExecutionSession } from "./float-mainnet-session.mjs";
import { validateIntentFile } from "./float-mainnet-intent.mjs";
import { assertHealthySpendMonitor } from "./float-mainnet-monitor-spend-guard.mjs";
import { atomicJson, checksum } from "./float-mainnet-purchase-store.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
export function loadPurchaseConfiguration(path) {
  path = resolve(path);
  const spec = read(path);
  const fields = ["schemaVersion", "session", "manifest", "monitorBaseline", "monitorStateDir", "storeDir", "providerUrl", "serviceName", "principal", "origins"];
  if (spec.schemaVersion !== 1 || fields.some((key) => !(key in spec)) || Object.keys(spec).some((key) => !fields.includes(key))) throw new Error("invalid purchase configuration fields");
  for (const key of ["session", "manifest", "monitorBaseline", "monitorStateDir", "storeDir"]) {
    if (typeof spec[key] !== "string" || !spec[key]) throw new Error("missing purchase configuration path");
    spec[key] = resolve(dirname(path), spec[key]);
  }
  const policy = readSessionPolicy(spec.session);
  if (policy.chainId !== "5042002") throw new Error("purchase HTTP service is Arc testnet only");
  if (typeof spec.principal !== "string" || !/^[1-9][0-9]{0,77}$/.test(spec.principal) || BigInt(spec.principal) > BigInt(policy.maxGrossPrincipal)) throw new Error("price must fit the session gross budget");
  if (typeof spec.serviceName !== "string" || !spec.serviceName.trim() || spec.serviceName.length > 160) throw new Error("invalid service name");
  const url = new URL(spec.providerUrl);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) throw new Error("provider needs HTTPS (HTTP permitted only on loopback)");
  if (!Array.isArray(spec.origins) || !spec.origins.length || spec.origins.some((raw) => { const u = new URL(raw); return u.origin !== raw || !(u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))); })) throw new Error("explicit HTTPS origins required (loopback allowed for development)");
  const pins = [path, spec.session, spec.manifest, spec.monitorBaseline];
  const hashes = pins.map((p) => checksum(readFileSync(p, "utf8")));
  const binding = checksum({ spec, policy, hashes });
  return { spec, policy, binding, assertConfiguration() {
    if (pins.some((p, i) => checksum(readFileSync(p, "utf8")) !== hashes[i])) throw new Error("configuration changed; stop and reconcile before restarting");
  } };
}

export async function createPurchaseAdapter(config, env = process.env) {
  const { spec, policy } = config;
  // Fail at startup without ever interpolating a key or RPC URL into an error.
  let account;
  try { account = privateKeyToAccount(env.FLOAT_EXECUTOR_PRIVATE_KEY); } catch { throw new Error("executor key unavailable or invalid"); }
  if (account.address.toLowerCase() !== policy.executor.toLowerCase()) throw new Error("executor key does not match enrollment");
  const executionKey = env.FLOAT_EXECUTOR_PRIVATE_KEY;
  const baseEnv = { PATH: env.PATH ?? "/usr/bin:/bin", ARC_RPC_URL: env.ARC_RPC_URL,
    FLOAT_MAINNET_EXPECTED_CHAIN_ID: policy.chainId, FLOAT_MAINNET_ADDRESS: policy.verifyingContract };
  const connection = await connectCandidate(readDeployment(baseEnv, { manifest: spec.manifest }));
  const common = ["--manifest", spec.manifest];
  const session = ["--session", spec.session, ...common];
  function tool(name, args, send = false) {
    config.assertConfiguration();
    return new Promise((resolveJob, reject) => {
      execFile(process.execPath, [join(SCRIPTS, `float-mainnet-${name}.mjs`), ...args], {
        // No NODE_OPTIONS, inherited wallet keys, or shell interpretation.
        env: { ...baseEnv, ...(send ? { FLOAT_EXECUTOR_PRIVATE_KEY: executionKey } : {}) },
        timeout: name === "request" && args[0] === "fetch" ? 180_000 : 120_000,
        killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout) => {
        let result;
        try { result = JSON.parse(stdout); } catch { /* never expose child stderr */ }
        if (error || result?.ok !== true) reject(new Error("candidate operation unavailable; preserve original state"));
        else resolveJob(result);
      });
    });
  }
  const work = (id) => {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid purchase id");
    return join(spec.storeDir, id);
  };
  const unsigned = (r) => join(work(r.id), "intent.json");
  function signed(r) {
    const path = join(work(r.id), "signed.json");
    atomicJson(path, { ...r.intent, signature: r.signature });
    return path;
  }
  return {
    assertConfiguration: config.assertConfiguration,
    async prepare(id) {
      mkdirSync(work(id), { mode: 0o700 });
      try {
        const path = join(work(id), "intent.json");
        await tool("intent", ["build", "--sponsor", policy.sponsor, "--agent", policy.agent, "--provider", policy.provider,
          "--endpoint-hash", policy.endpointHash, "--principal", spec.principal, "--executor", policy.executor,
          "--signature-ttl", "600", "--out", path, ...session]);
        const file = read(path);
        validateIntentFile(file, connection);
        return file;
      } catch (error) {
        // No signature or send exists at this stage. Do not accumulate scratch
        // directories when a temporarily unexecutable line is polled/retried.
        rmSync(work(id), { recursive: true, force: true });
        throw error;
      }
    },
    async verify(r, signature) {
      atomicJson(unsigned(r), r.intent);
      await tool("intent", ["verify", "--intent", unsigned(r), "--signature", signature, ...session]);
    },
    async accept(r) {
      const path = join(work(r.id), "acceptance.json");
      await tool("request", ["accept", "--provider-url", spec.providerUrl, "--intent", signed(r), "--request-id", r.requestId, "--out", path, ...common]);
      return read(path);
    },
    async preflight(r) {
      const { struct } = validateIntentFile(r.intent, connection);
      await assertHealthySpendMonitor({ baselinePath: spec.monitorBaseline, manifestPath: spec.manifest, stateDir: spec.monitorStateDir, sessionPolicy: policy, connection, struct });
      const result = await tool("submit", ["preflight", "--intent", signed(r), "--from", policy.executor, ...session]);
      if (result.outcome !== "pay") throw new Error("purchase would not pay; refresh policy before attempting");
    },
    async send(r) {
      return tool("submit", ["submit", "--intent", signed(r), "--execute", "--require-monitor",
        "--monitor-baseline", spec.monitorBaseline, "--monitor-state-dir", spec.monitorStateDir, ...session], true);
    },
    async status(r) {
      config.assertConfiguration();
      const { struct, digest } = validateIntentFile(r.intent, connection);
      return withExecutionSession(spec.session, connection, async (ledger) => {
        const report = await ledger.reconcile();
        const entry = ledger.check(struct, digest); // pending and changed outcomes hold
        return { payment: entry?.status ?? "unknown", txHash: entry?.txHash, observedAt: report.observedAt };
      });
    },
    async recover(r) {
      const acceptance = join(work(r.id), "acceptance.json"), resultPath = join(work(r.id), "result.bin");
      atomicJson(acceptance, r.acceptance);
      const result = await tool("request", ["fetch", "--provider-url", spec.providerUrl, "--intent", signed(r),
        "--request-id", r.requestId, "--acceptance", acceptance, "--out", resultPath, ...common]);
      return { encoding: "base64", bytes: readFileSync(resultPath).toString("base64"), resultHash: result.resultHash, delivery: result.delivery };
    },
  };
}

export function purchaseCatalog({ spec, policy }) {
  return { chainId: policy.chainId, candidate: policy.verifyingContract, sponsor: policy.sponsor, agent: policy.agent,
    executor: policy.executor, provider: policy.provider, endpointHash: policy.endpointHash, service: spec.serviceName,
    principal: spec.principal, denomination: "USDC base units (6 decimals)", maxGrossPrincipal: policy.maxGrossPrincipal };
}
