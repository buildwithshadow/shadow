import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import approval from './circle-cli-dependency-approval.json' with { type: 'json' };
import { inspectCircleCliDependencies, freezeCircleCliSource } from './circle-agent-cli-runtime.mjs';
import { rawCalldataCompatibility, guardedTestnetPurchaseCompatibility, guardedMainnetPurchaseCompatibility, CIRCLE_CLI_SHA256 } from './circle-agent-cli-transport.mjs';
import { circleCliEnvironment } from './circle-agent-cli-environment.mjs';

const runtime = fileURLToPath(new URL('../../tooling/circle-cli-runtime/', import.meta.url));
const entrypoint = join(runtime, 'node_modules/@circle-fin/cli/dist/index.js');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('the real installed Circle release matches the approved lock, source and complete dependency closure', async () => {
  const lock = await readFile(join(runtime, 'package-lock.json'));
  const installed = JSON.parse(await readFile(join(runtime, 'node_modules/@circle-fin/cli/package.json'), 'utf8'));
  const reference = approval.runtimes.find(r => r.platform === process.platform && r.arch === process.arch);
  assert(reference, 'This platform needs an independently prepared dependency approval.');
  assert.equal(sha256(lock), approval.lockfileSha256);
  assert.equal(installed.version, approval.circleVersion);
  assert.equal(installed.name, '@circle-fin/cli');
  assert.equal(sha256(await readFile(entrypoint)), CIRCLE_CLI_SHA256);
  assert.equal((await inspectCircleCliDependencies(entrypoint)).dependencyDigest, reference.dependencyDigest);
});

test('the frozen vendor and scoped compatibility copy boot without credentials and retain the vendor version', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'shadow-circle-vendor-'));
  try {
    const source = await readFile(entrypoint, 'utf8');
    const original = await freezeCircleCliSource(source, entrypoint, join(dir, 'cache'));
    const compatible = await freezeCircleCliSource(rawCalldataCompatibility(source), entrypoint, join(dir, 'cache'));
    const guardedSource = guardedTestnetPurchaseCompatibility(source);
    const guarded = await freezeCircleCliSource(guardedSource, entrypoint, join(dir, 'cache'));
    assert.match(guardedSource, /\["0xd39d55cc0c84408dcc409badb776459641dfd4be"\]\.includes\(contractAddress/);
    assert.match(guardedSource, /rawData\.toLowerCase\(\)\.startsWith/);
    const mainnetSource = guardedMainnetPurchaseCompatibility(source);
    const mainnet = await freezeCircleCliSource(mainnetSource, entrypoint, join(dir, 'cache'));
    const executeSection = mainnetSource.slice(mainnetSource.indexOf('async function handleAgentExecute('), mainnetSource.indexOf('async function handleLocalExecuteEstimate'));
    assert.match(executeSection, /blockchain !== 'ARC'/);
    assert.match(executeSection, /0x708c8c987eb4cd14445ac2c65ea712b2084888eb/);
    assert.match(executeSection, /rawData\.toLowerCase\(\)\.startsWith/);
    const environment = circleCliEnvironment({ HOME: dir, CIRCLE_CLI_HOME: join(dir, 'profile') });
    const run = (file, args) => execFileSync(process.execPath, [file, ...args], {
      env: environment, cwd: dir, encoding: 'utf8', timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(run(original, ['--version']).trim(), approval.circleVersion);
    assert.equal(run(compatible, ['--version']).trim(), approval.circleVersion);
    assert.equal(run(guarded, ['--version']).trim(), approval.circleVersion);
    assert.equal(run(mainnet, ['--version']).trim(), approval.circleVersion);
    assert.match(run(mainnet, ['wallet', 'execute', '--help']), /--idempotency-key/);
    assert.match(run(original, ['wallet', 'execute', '--help']), /--idempotency-key/);
    assert.match(run(compatible, ['wallet', 'execute', '--help']), /--estimate/);
    assert.match(run(original, ['wallet', 'login', '--help']), /Mainnet \(default\) and testnet.*?session/s);
    // An empty profile has no human terms acceptance. Inspection must refuse;
    // the test never sets acceptance flags or initiates login.
    assert.throws(() => run(original, ['wallet', 'status', '--type', 'agent', '--output', 'json']), error => {
      const status = JSON.parse(error.stdout);
      assert.equal(status.error.code, 'PERMISSION_DENIED');
      assert.match(status.error.message, /Terms acceptance is required/);
      return true;
    });
    assert.throws(() => rawCalldataCompatibility(source + '\n'), /source differs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
