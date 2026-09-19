import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, delimiter, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  findSolc,
  lineageProblems,
  machinePathHits,
  pickBuildInfo,
  reproductionProblems,
  treeState,
  treeWarnings,
  writePackage,
} from "./float-mainnet-review-package.mjs";
import {
  EXPECTED_COMPILER,
  PINNED_SOURCE_BLOBS,
  PINNED_SOURCE_COMMIT,
  loadArtifact,
  readSourceState,
  runtimeBytes,
} from "./float-mainnet-preflight.mjs";

const SCRIPT = fileURLToPath(new URL("./float-mainnet-review-package.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACT = "src/ShadowFloatMainnet.sol";
const REVIEW_DOCS = [
  "docs/MAINNET_PATH.md",
  "docs/SHADOW_FLOAT_MAINNET_PILOT_TEST_PLAN.md",
  "docs/SHADOW_FLOAT_MAINNET_SPEC.md",
  "docs/SHADOW_FLOAT_MAINNET_TEST_MATRIX.md",
  "docs/SHADOW_FLOAT_MAINNET_THREAT_MODEL.md",
];
const FORGE_TEST_COMMAND = 'forge test --root contracts --match-path "test/ShadowFloatMainnet*.t.sol" --json';
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

const root = mkdtempSync(join(tmpdir(), "float-review-package-"));
const first = join(root, "first");
let summary;
let stderr;
let artifact;
let source;
let buildInfo;
let solc;
let tree;

after(() => rmSync(root, { recursive: true, force: true }));

// The working tree holds uncommitted work while this suite is developed, so
// every build is a rehearsal unless a test says otherwise.
function build(out, args = ["--skip-tests", "--allow-dirty"]) {
  return spawnSync(process.execPath, [SCRIPT, "build", "--out", out, ...args], { encoding: "utf8", windowsHide: true });
}

// Independent of the package builder: git's blob id over the raw file bytes.
function gitBlob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

function readPackaged(out, path) {
  return readFileSync(join(out, path));
}

function manifestOf(out) {
  return JSON.parse(readFileSync(join(out, "PACKAGE_MANIFEST.json"), "utf8"));
}

// Every packaged file except the manifest, as writePackage takes them.
function filesOf(out) {
  return Object.fromEntries(
    listFiles(out)
      .filter((path) => path !== "PACKAGE_MANIFEST.json")
      .map((path) => [path, readPackaged(out, path)]),
  );
}

function assertManifestListsEveryFile(out) {
  const manifest = manifestOf(out);
  const files = listFiles(out).filter((path) => path !== "PACKAGE_MANIFEST.json");
  assert.deepEqual(Object.keys(manifest.files), files);
  for (const path of files) assert.equal(manifest.files[path], sha256(readPackaged(out, path)), path);
  return files;
}

// A package whose reduced input compiles to other bytecode: one signature check
// constant changed in the packaged source.
function corruptedFiles() {
  const files = filesOf(first);
  const text = files["build/build-info.json"].toString("utf8");
  const corrupted = text.replace("v != 28", "v != 29");
  assert.notEqual(corrupted, text, "the corruption must change the input");
  files["build/build-info.json"] = corrupted;
  return files;
}

// The first build also runs forge build when this checkout has no artifact yet.
before(() => {
  const run = build(first);
  assert.equal(run.status, 0, run.stderr);
  summary = JSON.parse(run.stdout);
  stderr = run.stderr;
  assert.equal(summary.ok, true);
  artifact = loadArtifact();
  source = readSourceState(artifact);
  buildInfo = JSON.parse(readFileSync(join(first, "build/build-info.json"), "utf8"));
  solc = findSolc();
  tree = treeState();
});

test("the manifest lists every packaged file with its sha256", () => {
  assert.deepEqual(assertManifestListsEveryFile(first), [
    "REVIEW_SCOPE.md",
    "build/ShadowFloatMainnet.json",
    "build/build-info.json",
    "contracts/foundry.toml",
    ...Object.keys(PINNED_SOURCE_BLOBS),
    ...REVIEW_DOCS,
  ].sort());
});

test("the summary prints the manifest's own sha256 and the solc reproduction", () => {
  assert.equal(summary.manifestSha256, sha256(readPackaged(first, "PACKAGE_MANIFEST.json")));
  assert.equal(summary.solcReproduction, "creation and runtime bytecode and ABI match");
});

test("packaged sources are byte for byte the pinned git blobs", () => {
  for (const [path, blob] of Object.entries(PINNED_SOURCE_BLOBS)) {
    assert.equal(gitBlob(readPackaged(first, path)), blob, path);
  }
});

// Moving the pins means re-reading the "Known behaviours" prose in reviewScope()
// against the new source before updating these values.
test("the pinned lineage is the one the known behaviours were written against", () => {
  assert.equal(PINNED_SOURCE_COMMIT, "2ebae7f63f6bdeed7ec9ad522f680af7b91b62ec");
  assert.deepEqual(PINNED_SOURCE_BLOBS, {
    "contracts/src/ShadowFloatMainnet.sol": "27964464803f73c7f451ad12e85a2bce5c6c4691",
    "contracts/src/interfaces/IERC20.sol": "20179c34a546c745efaa371ee2984e8dbcac60e4",
  });
});

test("docs and foundry.toml are the checkout's files with LF line endings", () => {
  for (const path of [...REVIEW_DOCS, "contracts/foundry.toml"]) {
    const expected = readFileSync(join(REPO_ROOT, path), "utf8").replace(/\r\n/g, "\n");
    assert.equal(readPackaged(first, path).toString("utf8"), expected, path);
  }
});

test("the manifest pins the lineage, compiler and runtime size and names the packaged commit", () => {
  const manifest = manifestOf(first);
  assert.deepEqual(manifest.pinnedLineage, { blobs: PINNED_SOURCE_BLOBS, commit: PINNED_SOURCE_COMMIT });
  assert.deepEqual(manifest.compiler, EXPECTED_COMPILER);
  assert.equal(manifest.runtimeBytes, runtimeBytes(artifact));
  assert.equal(manifest.packagedFromCommit, source.commit);
  assert.equal(manifest.contract, `${CONTRACT}:ShadowFloatMainnet`);
  assert.equal(manifest.tests, "not run (--skip-tests)");
});

test("the artifact is copied verbatim and the build-info holds exactly the pinned sources and this bytecode", () => {
  assert.deepEqual(
    readPackaged(first, "build/ShadowFloatMainnet.json"),
    readFileSync(join(REPO_ROOT, "contracts/out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json")),
  );
  assert.deepEqual(Object.keys(buildInfo.input), ["language", "settings", "sources"]);
  const pinned = Object.keys(PINNED_SOURCE_BLOBS).map((path) => path.slice("contracts/".length)).sort();
  assert.deepEqual(Object.keys(buildInfo.input.sources), pinned);
  assert.deepEqual(Object.keys(buildInfo.output.contracts), pinned);
  for (const path of Object.keys(PINNED_SOURCE_BLOBS)) {
    assert.equal(buildInfo.input.sources[path.slice("contracts/".length)].content, readPackaged(first, path).toString("utf8"));
  }
  const { evm } = buildInfo.output.contracts[CONTRACT].ShadowFloatMainnet;
  assert.equal(`0x${evm.bytecode.object}`, artifact.bytecode.object);
  assert.equal(`0x${evm.deployedBytecode.object}`, artifact.deployedBytecode.object);
  const text = readPackaged(first, "build/build-info.json").toString("utf8");
  const machinePath = REPO_ROOT.replace(/[\\/]+$/, "");
  for (const form of [machinePath, machinePath.split("\\").join("/")]) assert.ok(!text.includes(form), form);
});

test("the review scope names the pinned blobs, compiler, skipped tests and corrected known behaviours", () => {
  const scope = readPackaged(first, "REVIEW_SCOPE.md").toString("utf8");
  for (const blob of Object.values(PINNED_SOURCE_BLOBS)) assert.ok(scope.includes(blob), blob);
  assert.ok(scope.includes(PINNED_SOURCE_COMMIT));
  assert.ok(scope.includes(EXPECTED_COMPILER.version));
  assert.ok(scope.includes(`${runtimeBytes(artifact)} bytes`));
  assert.match(scope, /Tests were not run for this package/);
  assert.match(scope, /reproduces the manifest byte for byte only with `--skip-tests`/);
  assert.match(scope, /`LINE_EXPIRED` can never be recorded/);
  assert.match(scope, /The last timestamp at which a line can buy is therefore `line\.expiry - minimumRepaymentWindow`/);
  assert.match(scope, /one with stale terms reverts `StaleTerms`, which is checked first/);
  assert.match(scope, /if Arc supports EIP-7702, an EOA that has delegated its code has code, so it is routed to ERC-1271/);
});

test("the dirty flag and the rehearsal notice follow the working tree", () => {
  const manifest = manifestOf(first);
  const scope = readPackaged(first, "REVIEW_SCOPE.md").toString("utf8");
  assert.equal(manifest.dirty, tree.dirty.length > 0);
  assert.equal(summary.dirty, manifest.dirty);
  if (tree.dirty.length) {
    assert.match(scope, /\*\*Rehearsal package, not for review\.\*\* It was built with `--allow-dirty`/);
    for (const line of tree.dirty) assert.ok(scope.includes(`- \`${line}\``), line);
  } else {
    assert.doesNotMatch(scope, /Rehearsal package/);
  }
});

test("a dirty tree is refused without --allow-dirty and nothing is written", () => {
  const out = join(root, "strict");
  const run = build(out, ["--skip-tests"]);
  if (tree.dirty.length) {
    assert.equal(run.status, 1);
    assert.match(run.stderr, /refusing to package: uncommitted changes to packaged inputs/);
    for (const line of tree.dirty) assert.ok(run.stderr.includes(line), line);
    assert.equal(existsSync(out), false);
  } else {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(manifestOf(out).dirty, false);
  }
});

test("an unpushed HEAD is warned about, not refused", () => {
  const commit = source.commit;
  assert.deepEqual(treeWarnings({ dirty: [], remoteBranches: ["origin/main"] }, commit), []);
  const [warning, ...rest] = treeWarnings({ dirty: [], remoteBranches: [] }, commit);
  assert.deepEqual(rest, []);
  assert.equal(
    warning,
    `commit ${commit} is on no remote-tracking branch (git branch -r --contains HEAD); push it before sending the package, or the reviewer cannot fetch it`,
  );

  // This checkout: the build succeeded either way and warned exactly when HEAD is unpushed.
  assert.deepEqual(summary.warnings, treeWarnings(tree, commit));
  for (const line of summary.warnings) assert.ok(stderr.includes(`warning: ${line}`), line);
});

test("treeState reports uncommitted packaged inputs and remote-tracking branches holding HEAD", () => {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  const git = (...args) => {
    const run = spawnSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo, encoding: "utf8", env: gitEnv, windowsHide: true },
    );
    assert.equal(run.status, 0, run.stderr);
  };
  git("init", "-q");
  writeFileSync(join(repo, "docs/spec.md"), "spec\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  // The builder's own modules are packaged inputs; other scripts are not.
  const scripts = ["float-mainnet-manifest.mjs", "float-mainnet-preflight.mjs", "rpc-read-queue.mjs", "other.mjs"];
  mkdirSync(join(repo, "app/scripts"), { recursive: true });
  for (const name of scripts) writeFileSync(join(repo, "app/scripts", name), "// v1\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  assert.deepEqual(treeState(repo), { dirty: [], remoteBranches: [] });

  writeFileSync(join(repo, "docs/spec.md"), "edited\n");
  writeFileSync(join(repo, "README.md"), "not a packaged input\n");
  mkdirSync(join(repo, "contracts"));
  writeFileSync(join(repo, "contracts/New.sol"), "");
  writeFileSync(join(repo, "package.json"), "{}\n");
  for (const name of scripts) writeFileSync(join(repo, "app/scripts", name), "// v2\n");
  assert.deepEqual(treeState(repo).dirty, [
    " M app/scripts/float-mainnet-manifest.mjs",
    " M app/scripts/float-mainnet-preflight.mjs",
    " M app/scripts/rpc-read-queue.mjs",
    " M docs/spec.md",
    "?? contracts/",
    "?? package.json",
  ]);

  git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.deepEqual(treeState(repo).remoteBranches, ["origin/main"]);
});

test("two builds produce a byte-identical manifest with no wall-clock data", () => {
  const second = join(root, "second");
  const run = build(second);
  assert.equal(run.status, 0, run.stderr);
  const [one, two] = [first, second].map((out) => readFileSync(join(out, "PACKAGE_MANIFEST.json"), "utf8"));
  assert.equal(one, two);
  assert.equal(JSON.parse(run.stdout).manifestSha256, summary.manifestSha256);
  assert.doesNotMatch(one, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});

test("the default mode runs the tests and packages their results", () => {
  const out = join(root, "with-tests");
  const run = build(out, ["--allow-dirty"]);
  assert.equal(run.status, 0, run.stderr);
  const files = assertManifestListsEveryFile(out);
  assert.deepEqual(
    files.filter((path) => path.startsWith("results/")),
    ["results/forge-test.json", "results/scope-gate.txt"],
  );

  const suites = JSON.parse(readPackaged(out, "results/forge-test.json").toString("utf8"));
  const results = Object.values(suites).flatMap((suite) => Object.values(suite.test_results));
  const count = (status) => results.filter((result) => result.status === status).length;
  const forge = {
    command: FORGE_TEST_COMMAND,
    exitCode: 0,
    failed: 0,
    passed: count("Success"),
    skipped: count("Skipped"),
    suites: Object.keys(suites).length,
  };
  assert.ok(forge.passed > 0);
  assert.equal(count("Failure"), 0);
  const gateLine = readPackaged(out, "results/scope-gate.txt").toString("utf8");
  assert.match(gateLine, /^ShadowFloatMainnet scope gate PASS: \d+ runtime bytes/);

  const manifest = manifestOf(out);
  assert.deepEqual(manifest.tests, {
    forge,
    scopeGate: { command: "node contracts/test/mainnet-scope.test.mjs", output: gateLine.trimEnd(), status: 0 },
  });
  assert.deepEqual(JSON.parse(run.stdout).tests, manifest.tests);

  const scope = readPackaged(out, "REVIEW_SCOPE.md").toString("utf8");
  assert.ok(
    scope.includes(
      `\`results/forge-test.json\` is the unmodified output of \`${FORGE_TEST_COMMAND}\`: ${forge.passed} passed, 0 failed and ${forge.skipped} skipped across ${forge.suites} suites.`,
    ),
  );
  assert.ok(scope.includes("`results/scope-gate.txt` is the result line of `node contracts/test/mainnet-scope.test.mjs`."));
  assert.ok(scope.includes("- `results/`: the test outputs."));
  assert.doesNotMatch(scope, /Tests were not run/);
});

test("a non-empty --out directory and a missing command are refused", () => {
  const again = build(first);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /is not empty/);
  const usage = spawnSync(process.execPath, [SCRIPT, "--out", join(root, "usage")], { encoding: "utf8", windowsHide: true });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: /);
});

test("the packaged reduced input alone recompiles to the packaged artifact", () => {
  assert.deepEqual(reproductionProblems(first, solc), []);
});

test("a reduced input that compiles to other bytecode is refused", () => {
  const copy = join(root, "corrupted-copy");
  cpSync(first, copy, { recursive: true });
  writeFileSync(join(copy, "build/build-info.json"), corruptedFiles()["build/build-info.json"]);
  assert.deepEqual(reproductionProblems(copy, solc), [
    "solc's creation bytecode from build/build-info.json differs from build/ShadowFloatMainnet.json",
    "solc's runtime bytecode from build/build-info.json differs from build/ShadowFloatMainnet.json",
  ]);
});

test("a packaged artifact whose ABI is not solc's is refused", () => {
  const copy = join(root, "abi-edited-copy");
  cpSync(first, copy, { recursive: true });
  const edited = JSON.parse(readFileSync(join(copy, "build/ShadowFloatMainnet.json"), "utf8"));
  edited.abi = edited.abi.filter((item) => item.name !== "repay");
  assert.notEqual(edited.abi.length, artifact.abi.length, "the edit must drop an ABI entry");
  writeFileSync(join(copy, "build/ShadowFloatMainnet.json"), JSON.stringify(edited));
  assert.deepEqual(reproductionProblems(copy, solc), ["solc's ABI from build/build-info.json differs from build/ShadowFloatMainnet.json"]);
});

test("writePackage removes the partial package on a mismatch or a missing solc", () => {
  const manifestText = readFileSync(join(first, "PACKAGE_MANIFEST.json"), "utf8");

  const fresh = join(root, "mismatch-fresh");
  assert.throws(() => writePackage(fresh, corruptedFiles(), manifestText, solc), /refusing to package: solc's creation bytecode/);
  assert.equal(existsSync(fresh), false);

  const emptyDir = join(root, "mismatch-empty");
  mkdirSync(emptyDir);
  assert.throws(() => writePackage(emptyDir, corruptedFiles(), manifestText, solc), /runtime bytecode .* differs/);
  assert.deepEqual(readdirSync(emptyDir), []);

  const noSolc = join(root, "no-solc");
  assert.throws(() => writePackage(noSolc, filesOf(first), manifestText, join(root, "missing-solc")), /solc --standard-json did not run/);
  assert.equal(existsSync(noSolc), false);

  const good = join(root, "rewritten");
  writePackage(good, filesOf(first), manifestText, solc);
  assert.equal(readFileSync(join(good, "PACKAGE_MANIFEST.json"), "utf8"), manifestText);
});

test("a missing solc is refused", () => {
  assert.throws(() => findSolc([join(root, "no-svm", "0.8.24")]), /solc 0\.8\.24\+commit\.e11b9ed9 not found/);
});

test("a fresh checkout on a machine with no solc is built by forge before solc is looked up", () => {
  // A new clone of HEAD running this builder, with a home directory that holds
  // no compiler and a PATH with no forge. The home's forge is a copy of node,
  // so `forge build` runs the clone's `build` script, which does what forge
  // build does on a new machine: installs solc into the home's svm directory
  // and writes the artifact and its build-info.
  const checkout = join(root, "fresh-checkout");
  const home = join(root, "fresh-home");
  const svm = join(home, ".svm", "0.8.24");
  const git = (...args) => {
    const run = spawnSync("git", args, { encoding: "utf8", env: gitEnv, windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("clone", "-q", "--no-checkout", REPO_ROOT, checkout);
  git("-C", checkout, "checkout", "-q", git("-C", REPO_ROOT, "rev-parse", "HEAD"));
  cpSync(SCRIPT, join(checkout, "app/scripts/float-mainnet-review-package.mjs"));
  symlinkSync(join(REPO_ROOT, "app/node_modules"), join(checkout, "app/node_modules"), "junction");
  const forge = process.platform === "win32" ? "forge.exe" : "forge";
  mkdirSync(join(home, ".foundry", "bin"), { recursive: true });
  cpSync(process.execPath, join(home, ".foundry", "bin", forge));
  const built = join(REPO_ROOT, "contracts", "out");
  writeFileSync(
    join(checkout, "build"),
    [
      'const { cpSync, mkdirSync } = require("node:fs");',
      `mkdirSync(${JSON.stringify(svm)}, { recursive: true });`,
      `cpSync(${JSON.stringify(solc)}, ${JSON.stringify(join(svm, basename(solc)))});`,
      `cpSync(${JSON.stringify(join(built, "ShadowFloatMainnet.sol"))}, "contracts/out/ShadowFloatMainnet.sol", { recursive: true });`,
      `cpSync(${JSON.stringify(join(built, "build-info"))}, "contracts/out/build-info", { recursive: true });`,
    ].join("\n"),
  );
  const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH");
  const env = {
    ...process.env,
    [pathKey]: process.env[pathKey].split(delimiter).filter((dir) => !existsSync(join(dir, forge))).join(delimiter),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData"),
  };
  assert.throws(() => findSolc([svm]), /not found/);

  const run = spawnSync(
    process.execPath,
    [join(checkout, "app/scripts/float-mainnet-review-package.mjs"), "build", "--out", join(root, "fresh-package"), "--skip-tests", "--allow-dirty"],
    { encoding: "utf8", env, windowsHide: true },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /no build-info matches the artifact; running forge build --root contracts --build-info/);
  assert.equal(JSON.parse(run.stdout).solcReproduction, "creation and runtime bytecode and ABI match");
  assert.equal(findSolc([svm]), join(svm, basename(solc)));
});

test("packaged files naming this machine are refused", () => {
  const packaged = { ...filesOf(first), "PACKAGE_MANIFEST.json": readPackaged(first, "PACKAGE_MANIFEST.json") };
  assert.deepEqual(machinePathHits(packaged), []);

  // This checkout's root and this user's name planted in packaged files.
  const hits = machinePathHits({
    "REVIEW_SCOPE.md": `${packaged["REVIEW_SCOPE.md"]}\nbuilt in ${REPO_ROOT}\n`,
    "docs/notes.md": `copied from /mnt/c/Users/${userInfo().username}/shadow\n`,
  });
  assert.ok(hits.includes("REVIEW_SCOPE.md (repository root)"), hits.join(", "));
  if (REPO_ROOT.startsWith(homedir())) assert.ok(hits.includes("REVIEW_SCOPE.md (home directory)"), hits.join(", "));
  assert.ok(hits.includes("docs/notes.md (username)"), hits.join(", "));

  // Every form, against a fixed machine.
  const machine = { root: "C:\\Users\\alice\\src\\shadow\\", home: "C:\\Users\\alice", username: "alice" };
  assert.deepEqual(
    machinePathHits(
      {
        "forward.md": "see c:/users/alice/src/shadow/docs",
        "backslash.txt": "C:\\Users\\alice\\src\\shadow\\contracts",
        "escaped.json": JSON.stringify({ basePath: "C:\\Users\\alice\\src\\shadow" }),
        "home.md": "cache in C:/Users/Alice/.svm",
        "wsl.md": "/mnt/c/Users/ALICE/notes",
        "prose.md": "approved by alice; forge build --root contracts",
      },
      machine,
    ),
    [
      "forward.md (repository root)",
      "forward.md (home directory)",
      "forward.md (username)",
      "backslash.txt (repository root)",
      "backslash.txt (home directory)",
      "backslash.txt (username)",
      "escaped.json (repository root)",
      "escaped.json (home directory)",
      "escaped.json (username)",
      "home.md (home directory)",
      "home.md (username)",
      "wsl.md (username)",
    ],
  );
});

test("the build-info compiled from the pinned sources is chosen over a comment-only edit", () => {
  const edited = structuredClone(buildInfo);
  edited.input.sources[CONTRACT].content = `${edited.input.sources[CONTRACT].content}// comment-only edit\n`;
  assert.equal(pickBuildInfo([edited, buildInfo], artifact), buildInfo);
  assert.equal(pickBuildInfo([buildInfo, edited], artifact), buildInfo);
  // Without a pinned build-info the match is still returned, so lineageProblems names the drift.
  assert.equal(pickBuildInfo([edited], artifact), edited);

  const foreign = structuredClone(buildInfo);
  const { evm } = foreign.output.contracts[CONTRACT].ShadowFloatMainnet;
  evm.bytecode.object = `${evm.bytecode.object.slice(0, -2)}${evm.bytecode.object.endsWith("00") ? "01" : "00"}`;
  assert.equal(pickBuildInfo([foreign], artifact), null);
});

test("the checked-out build is the pinned lineage", () => {
  assert.deepEqual(lineageProblems({ artifact, source, buildInfo }), []);
});

test("a modified contract source is refused", () => {
  const edited = `${buildInfo.input.sources[CONTRACT].content}// edited\n`;
  const modified = structuredClone(source);
  // What readSourceState reports after the edit, before any rebuild.
  modified.files[`contracts/${CONTRACT}`] = {
    ...modified.files[`contracts/${CONTRACT}`],
    artifactMatchesWorkingTree: false,
    gitBlob: gitBlob(Buffer.from(edited)),
  };
  const problems = lineageProblems({ artifact, source: modified, buildInfo });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /compiled sources are not the pinned lineage [0-9a-f]{12}: contracts\/src\/ShadowFloatMainnet\.sol$/);
  assert.match(problems[1], /artifact was not built from the working tree: contracts\/src\/ShadowFloatMainnet\.sol/);

  // A build-info compiled from the edited source.
  const rebuilt = structuredClone(buildInfo);
  rebuilt.input.sources[CONTRACT].content = edited;
  assert.deepEqual(lineageProblems({ artifact, source, buildInfo: rebuilt }), [
    "build-info sources differ from the pinned blobs: contracts/src/ShadowFloatMainnet.sol",
  ]);
});

test("an unpinned compiled source is refused", () => {
  const extra = structuredClone(source);
  extra.files["contracts/src/Extra.sol"] = { ...extra.files["contracts/src/interfaces/IERC20.sol"] };
  assert.deepEqual(lineageProblems({ artifact, source: extra, buildInfo }), [
    `compiled sources are not the pinned lineage ${PINNED_SOURCE_COMMIT.slice(0, 12)}: contracts/src/Extra.sol`,
  ]);
});

test("other compiler settings are refused", () => {
  const reoptimized = structuredClone(artifact);
  reoptimized.metadata.settings.optimizer.runs = 200;
  const problems = lineageProblems({ artifact: reoptimized, source, buildInfo });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^artifact compiler settings differ from EXPECTED_COMPILER: .*"runs":200/);
});

test("a build-info that did not produce the artifact is refused", () => {
  const foreign = structuredClone(buildInfo);
  const { evm } = foreign.output.contracts[CONTRACT].ShadowFloatMainnet;
  evm.deployedBytecode.object = `${evm.deployedBytecode.object.slice(0, -2)}${evm.deployedBytecode.object.endsWith("00") ? "01" : "00"}`;
  assert.deepEqual(lineageProblems({ artifact, source, buildInfo: foreign }), ["build-info does not contain this artifact's bytecode and ABI"]);
});

test("a cached artifact whose ABI was edited is not matched to any build-info", () => {
  const edited = structuredClone(artifact);
  edited.abi = edited.abi.filter((item) => item.name !== "repay");
  assert.notEqual(edited.abi.length, artifact.abi.length, "the edit must drop an ABI entry");
  assert.equal(pickBuildInfo([buildInfo], edited), null);
  assert.deepEqual(lineageProblems({ artifact: edited, source, buildInfo }), ["build-info does not contain this artifact's bytecode and ABI"]);
});
