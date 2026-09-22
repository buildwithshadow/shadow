import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runScopeGate } from "./float-mainnet-manifest.mjs";
import {
  EXPECTED_COMPILER,
  MAX_RUNTIME_BYTES,
  PINNED_SOURCE_BLOBS,
  PINNED_SOURCE_COMMIT,
  compilerSettings,
  contractsRoot,
  errorMessage,
  isEntrypoint,
  pinnedLineageMismatches,
  readSourceState,
  runtimeBytes,
  sameJson,
  stableStringify,
} from "./float-mainnet-preflight.mjs";

const PACKAGE_SCHEMA = "shadow-float-mainnet-review-package/v1";
const repoRoot = resolve(contractsRoot, "..");
const artifactPath = resolve(contractsRoot, "out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json");
const buildInfoDir = resolve(contractsRoot, "out/build-info");
const CONTRACT_SOURCE = "src/ShadowFloatMainnet.sol";
const CONTRACT_NAME = "ShadowFloatMainnet";
const REVIEW_DOCS = [
  "docs/SHADOW_FLOAT_MAINNET_SPEC.md",
  "docs/SHADOW_FLOAT_MAINNET_THREAT_MODEL.md",
  "docs/SHADOW_FLOAT_MAINNET_TEST_MATRIX.md",
  "docs/SHADOW_FLOAT_MAINNET_PILOT_TEST_PLAN.md",
  "docs/MAINNET_PATH.md",
];
// Everything the package reads from the working tree: the reviewed docs, the
// contracts and foundry.toml, this builder, the modules it loads, the app's
// dependency manifests (they fix the viem those modules load) and the scripts
// that name it.
const PACKAGED_INPUTS = [
  "docs/",
  "contracts/",
  "app/scripts/float-mainnet-review-package.mjs",
  "app/scripts/float-mainnet-preflight.mjs",
  "app/scripts/float-mainnet-manifest.mjs",
  "app/scripts/rpc-read-queue.mjs",
  "app/package.json",
  "app/pnpm-lock.yaml",
  "package.json",
];
const FORGE_TEST_ARGS = ["test", "--root", "contracts", "--match-path", "test/ShadowFloatMainnet*.t.sol", "--json"];
const FORGE_TEST_COMMAND = 'forge test --root contracts --match-path "test/ShadowFloatMainnet*.t.sol" --json';
const SCOPE_GATE_COMMAND = "node contracts/test/mainnet-scope.test.mjs";

// As in float-mainnet-preflight.mjs: git gets no GIT_* variable that could point
// it at another repository or index. Windows variable names are case-insensitive.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

// forge gets no FOUNDRY_* or legacy DAPP_* variable, so foundry.toml alone
// sets what it builds and tests: an override such as FOUNDRY_FUZZ_RUNS=1 or
// another FOUNDRY_PROFILE cannot weaken the packaged test results.
const forgeEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(FOUNDRY|DAPP)_/i.test(name)));

// Build-info sources are keyed relative to contracts/, the pins relative to the repo.
const buildInfoPath = (pinnedPath) => pinnedPath.slice("contracts/".length);

// Same recipe as readSourceState: the git blob id of LF-normalized content.
function gitBlob(content) {
  return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// The same ABI entries. Order carries no meaning, and solc and Foundry list
// the entries, and their keys, in different orders.
function sameAbi(a, b) {
  const entries = (abi) => abi.map((entry) => stableStringify(entry)).sort();
  return sameJson(entries(a), entries(b));
}

// The ABI too: the package ships the artifact's ABI, and the scope gate reads it.
function producesArtifact(buildInfo, artifact) {
  const contract = buildInfo.output?.contracts?.[CONTRACT_SOURCE]?.[CONTRACT_NAME];
  return (
    contract?.evm !== undefined &&
    `0x${contract.evm.bytecode.object}` === artifact.bytecode.object &&
    `0x${contract.evm.deployedBytecode.object}` === artifact.deployedBytecode.object &&
    sameAbi(contract.abi, artifact.abi)
  );
}

// Pinned sources whose build-info content is missing or is not the pinned blob.
function driftedSources(buildInfo) {
  return Object.keys(PINNED_SOURCE_BLOBS).filter((path) => {
    const content = buildInfo.input?.sources?.[buildInfoPath(path)]?.content;
    return content === undefined || gitBlob(content) !== PINNED_SOURCE_BLOBS[path];
  });
}

// Everything that must hold before a reviewer is handed this build. Empty means
// the artifact, the working tree and the build-info are all the pinned lineage.
export function lineageProblems({ artifact, source, buildInfo }) {
  const problems = [];
  const compiler = compilerSettings(artifact);
  if (!sameJson(compiler, EXPECTED_COMPILER)) {
    problems.push(`artifact compiler settings differ from EXPECTED_COMPILER: ${stableStringify(compiler).replace(/\s+/g, "")}`);
  }
  const mismatches = pinnedLineageMismatches(source.files);
  if (mismatches.length) {
    problems.push(`compiled sources are not the pinned lineage ${PINNED_SOURCE_COMMIT.slice(0, 12)}: ${mismatches.join(", ")}`);
  }
  const stale = Object.keys(source.files)
    .sort()
    .filter((path) => !source.files[path].artifactMatchesWorkingTree);
  if (stale.length) {
    problems.push(`artifact was not built from the working tree: ${stale.join(", ")}; rebuild with forge build --root contracts --build-info`);
  }
  if (!producesArtifact(buildInfo, artifact)) problems.push("build-info does not contain this artifact's bytecode and ABI");
  const drifted = driftedSources(buildInfo);
  if (drifted.length) problems.push(`build-info sources differ from the pinned blobs: ${drifted.join(", ")}`);
  return problems;
}

// Of the build-infos that produced this bytecode, the one compiled from the
// pinned sources: a comment-only edit compiles to identical bytecode. With no
// such build-info, the first match, so lineageProblems names the drift.
export function pickBuildInfo(buildInfos, artifact) {
  const matching = buildInfos.filter((buildInfo) => producesArtifact(buildInfo, artifact));
  return matching.find((buildInfo) => driftedSources(buildInfo).length === 0) ?? matching[0] ?? null;
}

function findBuildInfo(artifact) {
  if (!existsSync(buildInfoDir)) return null;
  const names = readdirSync(buildInfoDir).filter((file) => file.endsWith(".json")).sort();
  return pickBuildInfo(
    names.map((name) => JSON.parse(readFileSync(join(buildInfoDir, name), "utf8"))),
    artifact,
  );
}

// PATH first, then ~/.foundry/bin, as float-mainnet-e2e.mjs finds anvil.
function findForge() {
  const candidates = ["forge", join(homedir(), ".foundry", "bin", process.platform === "win32" ? "forge.exe" : "forge")];
  const forge = candidates.find((bin) => spawnSync(bin, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0);
  if (!forge) throw new Error("forge not found on PATH or in ~/.foundry/bin; install Foundry");
  return forge;
}

const SOLC_SHORT_VERSION = EXPECTED_COMPILER.version.split("+")[0];

// Where Foundry's svm keeps compilers: ~/.svm, else the platform data directory.
function solcDirectories() {
  const bases = [
    join(homedir(), ".svm"),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, "svm")] : []),
    join(homedir(), ".local", "share", "svm"),
    join(homedir(), "Library", "Application Support", "svm"),
  ];
  return bases.map((base) => join(base, SOLC_SHORT_VERSION));
}

// The first installed solc-<version> binary that reports exactly EXPECTED_COMPILER's version.
export function findSolc(directories = solcDirectories()) {
  for (const dir of directories.filter((candidate) => existsSync(candidate))) {
    for (const name of readdirSync(dir).filter((file) => file.startsWith(`solc-${SOLC_SHORT_VERSION}`)).sort()) {
      const run = spawnSync(join(dir, name), ["--version"], { encoding: "utf8", windowsHide: true });
      if (run.status === 0 && run.stdout.includes(`Version: ${EXPECTED_COMPILER.version}`)) return join(dir, name);
    }
  }
  throw new Error(`solc ${EXPECTED_COMPILER.version} not found in ${directories.join(", ")}; forge build --root contracts installs it`);
}

function compileInput(input, solc) {
  const run = spawnSync(solc, ["--standard-json"], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (run.status !== 0) {
    throw new Error(`solc --standard-json did not run (status ${run.status}): ${run.error?.message ?? run.stderr.trim()}`);
  }
  const output = JSON.parse(run.stdout);
  if (!output.contracts?.[CONTRACT_SOURCE]?.[CONTRACT_NAME]?.evm) {
    const errors = (output.errors ?? []).filter((entry) => entry.severity === "error").map((entry) => entry.message);
    throw new Error(`solc produced no ${CONTRACT_SOURCE}:${CONTRACT_NAME} from build/build-info.json: ${errors.join("; ")}`);
  }
  return output;
}

// Foundry-compatible fields, all obtained from the same fresh compilation.
// Rebuilding the reduced input changes AST/source IDs from the whole-project
// build; its AST, source maps and immutable-reference keys must move together.
export function artifactFromCompilerOutput(output) {
  const contract = output.contracts[CONTRACT_SOURCE][CONTRACT_NAME];
  const source = output.sources[CONTRACT_SOURCE];
  const bytecode = (value, deployed = false) => ({
    object: `0x${value.object}`,
    sourceMap: value.sourceMap,
    linkReferences: value.linkReferences,
    ...(deployed ? { immutableReferences: value.immutableReferences } : {}),
  });
  return {
    abi: contract.abi,
    bytecode: bytecode(contract.evm.bytecode),
    deployedBytecode: bytecode(contract.evm.deployedBytecode, true),
    methodIdentifiers: contract.evm.methodIdentifiers,
    rawMetadata: contract.metadata,
    metadata: JSON.parse(contract.metadata),
    ast: source.ast,
    id: source.id,
  };
}

function executableProblems(expected, artifact) {
  const problems = [];
  if (expected.bytecode.object !== artifact.bytecode?.object) {
    problems.push("solc's creation bytecode from build/build-info.json differs from build/ShadowFloatMainnet.json");
  }
  if (expected.deployedBytecode.object !== artifact.deployedBytecode?.object) {
    problems.push("solc's runtime bytecode from build/build-info.json differs from build/ShadowFloatMainnet.json");
  }
  if (!Array.isArray(artifact.abi) || !sameAbi(expected.abi, artifact.abi)) problems.push("solc's ABI from build/build-info.json differs from build/ShadowFloatMainnet.json");
  return problems;
}

// Every shipped artifact field and the shipped compiler output must reproduce,
// including the immutable slots consumed by the release-manifest tooling.
export function reproductionProblems(packageDir, solc) {
  const buildInfo = JSON.parse(readFileSync(join(packageDir, "build/build-info.json"), "utf8"));
  const artifact = JSON.parse(readFileSync(join(packageDir, "build/ShadowFloatMainnet.json"), "utf8"));
  let output;
  try {
    output = compileInput(buildInfo.input, solc);
  } catch (error) {
    return [errorMessage(error)];
  }
  const expected = artifactFromCompilerOutput(output);
  const problems = executableProblems(expected, artifact);
  const withoutObject = (value) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => key !== "object"));
  for (const key of ["bytecode", "deployedBytecode"]) {
    if (!sameJson(withoutObject(artifact[key]), withoutObject(expected[key]))) {
      problems.push(`solc's ${key} metadata from build/build-info.json differs from build/ShadowFloatMainnet.json`);
    }
  }
  for (const key of ["methodIdentifiers", "rawMetadata", "metadata", "ast", "id"]) {
    if (!sameJson(artifact[key], expected[key])) problems.push(`solc's ${key} from build/build-info.json differs from build/ShadowFloatMainnet.json`);
  }
  if (!sameJson(Object.keys(artifact).sort(), Object.keys(expected).sort())) problems.push("build/ShadowFloatMainnet.json contains missing or unverified fields");
  if (!sameJson(buildInfo.output, reviewBuildInfo({ ...buildInfo, output }).output)) problems.push("solc's output differs from the retained build/build-info.json output");
  if (buildInfo.solcVersion !== SOLC_SHORT_VERSION || buildInfo.solcLongVersion !== EXPECTED_COMPILER.version) problems.push("build/build-info.json compiler version differs from the verified solc version");
  return problems;
}

// What `git status --porcelain` reports for the packaged inputs, and the
// remote-tracking branches a reviewer could fetch HEAD from.
export function treeState(cwd = repoRoot) {
  const git = (args) => {
    const run = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv, windowsHide: true });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")} exited ${run.status}: ${run.error?.message ?? run.stderr.trim()}`);
    return run.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  };
  return {
    dirty: git(["status", "--porcelain", "--", ...PACKAGED_INPUTS]),
    remoteBranches: git(["branch", "-r", "--contains", "HEAD"]).map((line) => line.trim()),
  };
}

// A reviewer can fetch only a pushed commit; an unpushed one is warned about, not refused.
export function treeWarnings(tree, commit) {
  return tree.remoteBranches.length
    ? []
    : [`commit ${commit} is on no remote-tracking branch (git branch -r --contains HEAD); push it before sending the package, or the reviewer cannot fetch it`];
}

// Packaged files that name this machine: the repository root or home directory
// with either separator or JSON-escaped, or the username as a path component.
// Case-insensitive, because Windows paths are.
export function machinePathHits(files, { root = repoRoot, home = homedir(), username = userInfo().username } = {}) {
  const forms = (path) => {
    const trimmed = path.replace(/[\\/]+$/, "");
    const backslash = trimmed.split("/").join("\\");
    return [trimmed, trimmed.split("\\").join("/"), backslash, JSON.stringify(backslash).slice(1, -1)]
      .filter((form) => form.length > 0)
      .map((form) => form.toLowerCase());
  };
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const usernameInPath = new RegExp(`(?<=[\\\\/])${escaped}(?![A-Za-z0-9_.-])`, "i");
  const hits = [];
  for (const [path, content] of Object.entries(files)) {
    const text = content.toString("utf8");
    const lower = text.toLowerCase();
    if (forms(root).some((form) => lower.includes(form))) hits.push(`${path} (repository root)`);
    if (forms(home).some((form) => lower.includes(form))) hits.push(`${path} (home directory)`);
    if (usernameInPath.test(text)) hits.push(`${path} (username)`);
  }
  return hits;
}

// Snapshot the cached artifact for lineage and executable-code checks. The
// shipped artifact is regenerated independently, never copied from this cache.
function readArtifact() {
  return { artifact: JSON.parse(readFileSync(artifactPath, "utf8")) };
}

function loadBuild() {
  let build = existsSync(artifactPath) ? readArtifact() : null;
  let buildInfo = build && findBuildInfo(build.artifact);
  if (buildInfo) return { ...build, buildInfo };

  console.error("no build-info matches the artifact; running forge build --root contracts --build-info");
  const run = spawnSync(findForge(), ["build", "--root", "contracts", "--build-info"], {
    cwd: repoRoot,
    env: forgeEnv,
    stdio: ["ignore", 2, 2],
    windowsHide: true,
  });
  if (run.status !== 0) throw new Error(`forge build --root contracts --build-info exited ${run.status}`);
  build = readArtifact();
  buildInfo = findBuildInfo(build.artifact);
  if (!buildInfo) {
    throw new Error("no build-info in contracts/out/build-info produced the artifact; run forge build --root contracts --build-info --force");
  }
  return { ...build, buildInfo };
}

// The standard JSON for the two pinned sources only. Forge adds `version` and
// the machine-local `allowPaths`, `basePath` and `includePaths` to the input;
// solc rejects those keys, so they are dropped.
function reviewBuildInfo(buildInfo) {
  const paths = Object.keys(PINNED_SOURCE_BLOBS).map(buildInfoPath);
  const pinnedOnly = (record) => Object.fromEntries(paths.filter((path) => path in record).map((path) => [path, record[path]]));
  return {
    input: {
      language: buildInfo.input.language,
      settings: buildInfo.input.settings,
      sources: pinnedOnly(buildInfo.input.sources),
    },
    output: {
      contracts: pinnedOnly(buildInfo.output.contracts),
      errors: (buildInfo.output.errors ?? []).filter((entry) => paths.includes(entry.sourceLocation?.file)),
      sources: pinnedOnly(buildInfo.output.sources),
    },
    solcLongVersion: EXPECTED_COMPILER.version,
    solcVersion: SOLC_SHORT_VERSION,
  };
}

function runForgeTests() {
  const run = spawnSync(findForge(), FORGE_TEST_ARGS, {
    cwd: repoRoot,
    env: forgeEnv,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  let suites;
  try {
    suites = JSON.parse(run.stdout);
  } catch {
    throw new Error(`${FORGE_TEST_COMMAND} printed no JSON (exit ${run.status}): ${run.stderr.trim()}`);
  }
  const results = Object.values(suites).flatMap((suite) => Object.values(suite.test_results));
  const count = (status) => results.filter((result) => result.status === status).length;
  return {
    stdout: run.stdout,
    summary: {
      command: FORGE_TEST_COMMAND,
      exitCode: run.status,
      failed: count("Failure"),
      passed: count("Success"),
      skipped: count("Skipped"),
      suites: Object.keys(suites).length,
    },
  };
}

function runTests() {
  const forge = runForgeTests();
  const { passed, failed, exitCode } = forge.summary;
  if (exitCode !== 0 || failed !== 0 || passed === 0) {
    throw new Error(`${FORGE_TEST_COMMAND} failed: exit ${exitCode}, ${passed} passed, ${failed} failed`);
  }
  const gate = runScopeGate();
  if (gate.status !== 0) throw new Error(`${SCOPE_GATE_COMMAND} failed: ${gate.output}`);
  return { forge, scopeGate: { command: SCOPE_GATE_COMMAND, output: gate.output, status: gate.status } };
}

function reviewScope({ artifact, commit, dirty, tests }) {
  const compiler = compilerSettings(artifact);
  const code = (value) => `\`${value}\``;
  const lines = [
    "# ShadowFloatMainnet security review scope",
    "",
    `Candidate source lineage: commit ${code(PINNED_SOURCE_COMMIT)}. This package was built from repository commit ${code(commit)}. \`PACKAGE_MANIFEST.json\` records the sha256 of every other file in this directory. The builder prints the manifest's own sha256; check it against the value sent to you separately. A rebuild from the same commit reproduces the manifest byte for byte only with \`--skip-tests\`, because test durations and fuzz gas figures change \`results/forge-test.json\` on every run.`,
    ...(dirty.length
      ? [
          "",
          `**Rehearsal package, not for review.** It was built with \`--allow-dirty\` from a working tree with uncommitted changes, so its docs, \`foundry.toml\`, test results and this file may differ from what commit ${code(commit)} produces. The two in-scope sources are still the pinned blobs. Uncommitted paths (\`git status --porcelain\`):`,
          "",
          ...dirty.map((line) => `- ${code(line)}`),
        ]
      : []),
    "",
    "The package covers source and build only and records no deployment. Each authorized deployment gets its own release manifest (`app/scripts/float-mainnet-manifest.mjs`) with addresses, chain configuration and bytecode checks.",
    "",
    "## In scope",
    "",
    "| File | Git blob |",
    "| --- | --- |",
    ...Object.entries(PINNED_SOURCE_BLOBS).map(([path, blob]) => `| ${code(path)} | ${code(blob)} |`),
    "",
    `Compiled with solc ${code(compiler.version)}, EVM ${code(compiler.settings.evmVersion)}, optimizer ${compiler.settings.optimizer.enabled ? "on" : "off"} with ${code(`runs = ${compiler.settings.optimizer.runs}`)}, ${code("viaIR")}, bytecode hash ${code(compiler.settings.metadata.bytecodeHash)} and no CBOR metadata (\`contracts/foundry.toml\`). Runtime bytecode is ${runtimeBytes(artifact)} bytes; the specification's limit is ${MAX_RUNTIME_BYTES}.`,
    "",
    "The intended behaviour is specified in `docs/SHADOW_FLOAT_MAINNET_SPEC.md`, the threats in `docs/SHADOW_FLOAT_MAINNET_THREAT_MODEL.md` and the invariant-to-test mapping in `docs/SHADOW_FLOAT_MAINNET_TEST_MATRIX.md`. `docs/SHADOW_FLOAT_MAINNET_PILOT_TEST_PLAN.md` lists the contract tests behind each pilot step. `docs/MAINNET_PATH.md` is background.",
    "",
    "## Out of scope",
    "",
    "- Testnet `ShadowFloat` V2 (`contracts/src/ShadowFloat.sol`) and every other contract in the repository. The package artifact and build-info are freshly compiled from only the two in-scope sources; their bytecodes and ABI must also match the checked Foundry build.",
    "- The off-chain tools: the preflight, release manifest, participant CLIs and this package builder (`app/scripts/float-mainnet-*.mjs`).",
    "- Deployment configuration values: chain ID, USDC address, cap maxima and initial values, repayment windows and governance delay. The proposed values in the pilot test plan await owner approval.",
    "",
    "## Known behaviours",
    "",
    "These are deliberate or already documented. Please do not report them as new findings, but do say if you consider one a defect.",
    "",
    "1. **`LINE_EXPIRED` can never be recorded.** `_blockReason` returns it when `block.timestamp > line.expiry`, but `executeSpend` first requires `dueAt >= block.timestamp + minimumRepaymentWindow` and `dueAt <= line.expiry`, and `minimumRepaymentWindow` is nonzero. The last timestamp at which a line can buy is therefore `line.expiry - minimumRepaymentWindow`. After it, an intent with current terms reverts `InvalidIntent` and one with stale terms reverts `StaleTerms`, which is checked first; either way `_blockReason` never runs, and the branch is unreachable.",
    "2. **Caps bound principal, not purchase count.** The per-spend, daily and cumulative line-spend caps compare principal amounts; nothing counts purchases. The only count limit is one outstanding draw per line. Repayment never reduces `cumulativePrincipalPaid`.",
    "3. **A second draw while `DRAWN` reverts before signature validation.** `executeSpend` reverts `InvalidState` for a `DRAWN` line before it computes the digest or calls `_validateSignature`, so such an intent reports `InvalidState` whatever its signature and consumes no nonce or receipt. The line, terms, intent-field and nonce checks run before that.",
    "4. **ERC-1271 applies only when the signer has code.** `_validateSignature` calls `isValidSignature` only if the agent address has code. Otherwise it requires a 65-byte ECDSA signature with low `s` and `v` of 27 or 28 that recovers to the agent. A signature for a smart account that is not yet deployed fails with `InvalidSignature`; counterfactual (ERC-6492-style) signatures are not unwrapped. Inferred from that code path, not tested: if Arc supports EIP-7702, an EOA that has delegated its code has code, so it is routed to ERC-1271 and its plain ECDSA signature fails with `InvalidSignature` unless the delegate implements `isValidSignature`.",
    "5. **There is no fee surface.** By specification (sections 1 and 7) there is no fee parameter, fee accounting, fee event or fee withdrawal. The scope gate (`contracts/test/mainnet-scope.test.mjs`) fails if an ABI function or event name contains `fee` or another excluded term.",
    "",
    "## Questions for the reviewer",
    "",
    "1. Can any call sequence let one line's reserve pay another line's provider, or leave the contract's USDC balance below `totalSponsorObligations` (`CAP-01`, `CAP-02`)?",
    "2. Does every material line or provider-policy change alter `currentTermsHash`, so that no earlier signature survives a terms change, close or reopen (`SIG-01`, `SIG-02`)?",
    "3. Can one digest pay a provider twice, including through ERC-1271 validation, a token callback or a relayer retry (`SIG-03`)?",
    "4. Can any pause, allowlist removal, cap change or ownership action block `repay`, an eligible `declareDefault`, `closeLine`, `claimDefaulted` or `cancelNonce` (`EXIT-01`)?",
    "5. Are the exact balance-delta checks sufficient for a USDC that can pause or blocklist a sender or recipient (`TOK-01`, `CAP-03`)?",
    "6. Can a cap increase take effect before the governance delay, above its immutable maximum or above a line's sponsor-accepted ceiling, and can an operator do more than pause and cancel a queued increase (`GOV-01`, `ROLE-01`)?",
    "7. Is any behaviour listed above a defect rather than an accepted limitation?",
    "",
    "The invariant IDs are defined in section 10 of the specification.",
    "",
    "## Reproduce the build",
    "",
    `With Foundry, which installs solc ${code(compiler.version)} if it is missing. Run from this directory; the build goes to a sibling directory so the package stays unchanged:`,
    "",
    "```sh",
    "cp -R contracts ../float-review-build",
    "forge build --root ../float-review-build",
    "node -e '",
    'const art = require("./build/ShadowFloatMainnet.json");',
    'const out = require("../float-review-build/out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json");',
    'const canon = (v) => (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v));',
    'const abi = (list) => JSON.stringify(list.map(canon).sort());',
    "const same = out.bytecode.object === art.bytecode.object && out.deployedBytecode.object === art.deployedBytecode.object && abi(out.abi) === abi(art.abi);",
    `console.log(same ? "reproduces the executable bytecodes and ABI" : "MISMATCH"); process.exit(same ? 0 : 1);'`,
    "```",
    "",
    `With solc directly, where \`solc-0.8.24\` is the ${code(compiler.version)} binary. The builder ran this check before writing the manifest and refuses to package on a mismatch:`,
    "",
    "```sh",
    `node -e 'process.stdout.write(JSON.stringify(require("./build/build-info.json").input))' > ../float-review-input.json`,
    "solc-0.8.24 --standard-json < ../float-review-input.json > ../float-review-output.json",
    "node -e '",
    'const out = require("../float-review-output.json").contracts["src/ShadowFloatMainnet.sol"].ShadowFloatMainnet;',
    'const art = require("./build/ShadowFloatMainnet.json");',
    'const canon = (v) => (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v));',
    'const abi = (list) => JSON.stringify(list.map(canon).sort());',
    'const source = require("../float-review-output.json").sources["src/ShadowFloatMainnet.sol"];',
    'const code = (v, deployed = false) => ({object: "0x" + v.object, sourceMap: v.sourceMap, linkReferences: v.linkReferences, ...(deployed ? {immutableReferences: v.immutableReferences} : {})});',
    'const expected = {abi: out.abi, bytecode: code(out.evm.bytecode), deployedBytecode: code(out.evm.deployedBytecode, true), methodIdentifiers: out.evm.methodIdentifiers, rawMetadata: out.metadata, metadata: JSON.parse(out.metadata), ast: source.ast, id: source.id};',
    'const same = abi(out.abi) === abi(art.abi) && canon({...expected, abi: []}) === canon({...art, abi: []});',
    `console.log(same ? "reproduces the artifact" : "MISMATCH"); process.exit(same ? 0 : 1);'`,
    "```",
    "",
    "`build/build-info.json` contains a standard JSON input reduced to the two in-scope sources and the fresh solc output for that input. Foundry's `version`, `allowPaths`, `basePath` and `includePaths` input keys are removed because solc rejects them and the paths are local to the build machine. The artifact retains only compiler-backed fields and is reconstructed from that same fresh output, including its AST, source maps, method identifiers, metadata and immutable references. These identifiers may differ from a whole-project Foundry build: they must be compared together against the reduced compilation, as in the solc command above. The builder checks every retained artifact field and compiler-output field, not only bytecodes and ABI. The ABI is compared as a set of entries because solc and Foundry may list entries in different orders.",
    "",
    "## Test results",
    "",
    ...(tests
      ? [
          `\`results/forge-test.json\` is the unmodified output of \`${tests.forge.summary.command}\`: ${tests.forge.summary.passed} passed, ${tests.forge.summary.failed} failed and ${tests.forge.summary.skipped} skipped across ${tests.forge.summary.suites} suites. Its durations and fuzz gas figures differ between runs. \`results/scope-gate.txt\` is the result line of \`${tests.scopeGate.command}\`.`,
        ]
      : [
          `Tests were not run for this package (\`--skip-tests\`). From the repository at commit ${code(commit)}:`,
          "",
          "```sh",
          FORGE_TEST_COMMAND.replace(" --json", ""),
          SCOPE_GATE_COMMAND,
          "```",
        ]),
    "",
    "## Contents",
    "",
    "- `contracts/`: the two in-scope sources exactly as compiled (LF line endings, identical to the pinned git blobs) and `foundry.toml`.",
    "- `build/ShadowFloatMainnet.json`: a Foundry-compatible artifact regenerated from the reduced solc compilation (ABI, bytecode, immutable references and verified compiler metadata).",
    "- `build/build-info.json`: standard JSON input and output (see \"Reproduce the build\").",
    "- `docs/`: the specification, threat model, test matrix, pilot test plan and mainnet path, with LF line endings. Their links to other repository files resolve in the repository, not in this package.",
    ...(tests ? ["- `results/`: the test outputs."] : []),
    "",
  ];
  return lines.join("\n");
}

function packageFiles({ artifact, artifactBytes, buildInfo, commit, dirty, tests }) {
  const lf = (path) => readFileSync(resolve(repoRoot, path), "utf8").replace(/\r\n/g, "\n");
  const files = {
    "REVIEW_SCOPE.md": reviewScope({ artifact, commit, dirty, tests }),
    "build/ShadowFloatMainnet.json": artifactBytes,
    "build/build-info.json": `${stableStringify(reviewBuildInfo(buildInfo))}\n`,
    "contracts/foundry.toml": lf("contracts/foundry.toml"),
  };
  for (const path of Object.keys(PINNED_SOURCE_BLOBS)) files[path] = buildInfo.input.sources[buildInfoPath(path)].content;
  for (const path of REVIEW_DOCS) files[path] = lf(path);
  if (tests) {
    files["results/forge-test.json"] = tests.forge.stdout;
    files["results/scope-gate.txt"] = `${tests.scopeGate.output}\n`;
  }
  return files;
}

function packageManifest({ artifact, commit, dirty, files, tests }) {
  return {
    compiler: compilerSettings(artifact),
    contract: `${CONTRACT_SOURCE}:${CONTRACT_NAME}`,
    dirty: dirty.length > 0,
    files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)])),
    packagedFromCommit: commit,
    pinnedLineage: { blobs: PINNED_SOURCE_BLOBS, commit: PINNED_SOURCE_COMMIT },
    runtimeBytes: runtimeBytes(artifact),
    schema: PACKAGE_SCHEMA,
    tests: tests ? { forge: tests.forge.summary, scopeGate: tests.scopeGate } : "not run (--skip-tests)",
  };
}

// Writes the files, proves with solc that the packaged reduced input alone
// reproduces the packaged artifact, and only then writes the manifest. On any
// failure `out` is left as it was found: absent or empty.
export function writePackage(out, files, manifestText, solc) {
  const existed = existsSync(out);
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(out, path)), { recursive: true });
      writeFileSync(join(out, path), content);
    }
    const problems = reproductionProblems(out, solc);
    if (problems.length) throw new Error(`refusing to package: ${problems.join("; ")}`);
    writeFileSync(join(out, "PACKAGE_MANIFEST.json"), manifestText);
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    if (existed) mkdirSync(out);
    throw error;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      "skip-tests": { type: "boolean", default: false },
      "allow-dirty": { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== "build" || !values.out) {
    throw new Error("usage: node app/scripts/float-mainnet-review-package.mjs build --out <dir> [--skip-tests] [--allow-dirty]");
  }
  const out = resolve(values.out);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`--out ${out} is not empty; choose a new directory`);

  const tree = treeState();
  if (tree.dirty.length && !values["allow-dirty"]) {
    throw new Error(
      `refusing to package: uncommitted changes to packaged inputs (${tree.dirty.join(", ")}); commit them, or pass --allow-dirty for a rehearsal package`,
    );
  }

  // After loadBuild: its forge build installs solc on a machine that has none yet.
  const { artifact, buildInfo } = loadBuild();
  const solc = findSolc();
  const source = readSourceState(artifact);
  const problems = lineageProblems({ artifact, source, buildInfo });
  if (problems.length) throw new Error(`refusing to package: ${problems.join("; ")}`);

  const warnings = treeWarnings(tree, source.commit);
  for (const warning of warnings) console.error(`warning: ${warning}`);

  const tests = values["skip-tests"] ? null : runTests();
  const reduced = reviewBuildInfo(buildInfo);
  const output = compileInput(reduced.input, solc);
  const reviewedArtifact = artifactFromCompilerOutput(output);
  const executableMismatch = executableProblems(reviewedArtifact, artifact);
  if (executableMismatch.length) throw new Error(`refusing to package: ${executableMismatch.join("; ")}`);
  const files = packageFiles({ artifact: reviewedArtifact, artifactBytes: `${stableStringify(reviewedArtifact)}\n`, buildInfo: { ...reduced, output }, commit: source.commit, dirty: tree.dirty, tests });
  const manifestText = `${stableStringify(packageManifest({ artifact: reviewedArtifact, commit: source.commit, dirty: tree.dirty, files, tests }))}\n`;
  const hits = machinePathHits({ ...files, "PACKAGE_MANIFEST.json": manifestText });
  if (hits.length) throw new Error(`refusing to package: machine-local paths in ${hits.join(", ")}`);
  writePackage(out, files, manifestText, solc);

  const manifest = JSON.parse(manifestText);
  console.log(
    JSON.stringify(
      {
        ok: true,
        out,
        files: Object.keys(files).length + 1,
        manifestSha256: sha256(manifestText),
        dirty: manifest.dirty,
        runtimeBytes: manifest.runtimeBytes,
        solcReproduction: "creation and runtime bytecode, ABI and all retained compiler metadata match",
        tests: manifest.tests,
        warnings,
      },
      null,
      2,
    ),
  );
}

if (isEntrypoint(import.meta)) {
  main().catch((error) => {
    console.error(`review package aborted: ${errorMessage(error)}`);
    process.exit(1);
  });
}
