import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { http, keccak256, numberToHex, toBytes } from "viem";

import {
  BLOCK_REASONS,
  LINE_STATES,
  SPEND_INTENT_TYPE_STRING,
  endpointHashFrom,
  floatAbi,
  readDeployment,
  walletFromEnv,
} from "./float-mainnet-config.mjs";
import { SECP256K1_HALF_ORDER } from "./float-mainnet-intent.mjs";
import { loadArtifact } from "./float-mainnet-preflight.mjs";

const source = readFileSync(new URL("../../contracts/src/ShadowFloatMainnet.sol", import.meta.url), "utf8");
const ADDRESS = "0x000000000000000000000000000000000000f10a";
const OTHER = "0x000000000000000000000000000000000000beef";
const ENV = { ARC_RPC_URL: "http://127.0.0.1:8545", FLOAT_MAINNET_EXPECTED_CHAIN_ID: "5042002", FLOAT_MAINNET_ADDRESS: ADDRESS };

function enumMembers(name) {
  const match = source.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  return match[1].split(",").map((member) => member.trim()).filter(Boolean);
}

test("the committed ABI equals the compiled artifact's ABI", () => {
  assert.deepEqual(floatAbi, loadArtifact().abi);
});

test("the EIP-712 SpendIntent type string is the contract's typehash preimage", () => {
  const preimage = source.match(/SPEND_INTENT_TYPEHASH = keccak256\(\s*"([^"]+)"/)[1];
  assert.equal(SPEND_INTENT_TYPE_STRING, preimage);
});

test("enum names follow the contract's declaration order", () => {
  assert.deepEqual(LINE_STATES, enumMembers("LineState"));
  assert.deepEqual(BLOCK_REASONS, enumMembers("BlockReason"));
});

test("endpoint hashes are an exact bytes32 or keccak256 of the endpoint string", () => {
  const hash = keccak256(toBytes("https://provider.example/api/ask"));
  assert.equal(endpointHashFrom({ endpoint: "https://provider.example/api/ask" }), hash);
  assert.equal(endpointHashFrom({ endpointHash: hash.toUpperCase().replace("0X", "0x") }), hash);
  assert.throws(() => endpointHashFrom({}), /--endpoint/);
  assert.throws(() => endpointHashFrom({ endpointHash: "0x1234" }), /bytes32/);
  assert.throws(() => endpointHashFrom({ endpoint: "a", endpointHash: hash }), /not both/);
});

test("the deployment must be named explicitly and consistently", () => {
  assert.equal(readDeployment(ENV).address, "0x000000000000000000000000000000000000F10a");
  assert.equal(readDeployment(ENV).expectedChainId, 5042002n);
  assert.deepEqual([readDeployment(ENV).runtimeHash, readDeployment(ENV).deployBlock], [null, null]);
  assert.throws(() => readDeployment({ ...ENV, ARC_RPC_URL: "" }), /ARC_RPC_URL/);
  assert.throws(() => readDeployment({ ...ENV, FLOAT_MAINNET_EXPECTED_CHAIN_ID: "arc" }), /chain id/);
  assert.throws(() => readDeployment({ ...ENV, FLOAT_MAINNET_ADDRESS: "" }), /FLOAT_MAINNET_ADDRESS/);
});

test("a manifest is trusted only when it passed, is for this chain and records the runtime code hash", () => {
  const runtimeHash = keccak256(toBytes("runtime code"));
  const release = {
    ok: true,
    chainId: "5042002",
    contract: { address: ADDRESS },
    bytecode: { onchainRuntimeKeccak256: runtimeHash },
    deployment: { blockNumber: "4242" },
  };
  const dir = mkdtempSync(join(tmpdir(), "float-manifest-"));
  try {
    const manifest = (value) => {
      const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    const unset = { ...ENV, FLOAT_MAINNET_ADDRESS: "" };
    const read = readDeployment(unset, { manifest: manifest(release) });
    assert.deepEqual(
      [read.address, read.runtimeHash, read.deployBlock],
      [readDeployment(ENV).address, runtimeHash, 4242n],
    );
    assert.equal(readDeployment(ENV, { manifest: manifest(release) }).address, read.address);
    assert.throws(() => readDeployment({ ...ENV, FLOAT_MAINNET_ADDRESS: OTHER }, { manifest: manifest(release) }), /differ/);
    assert.throws(() => readDeployment(unset, { manifest: manifest({ ...release, ok: false }) }), /not a passing release manifest \(ok is false\)/);
    assert.throws(() => readDeployment(unset, { manifest: manifest({ ...release, ok: undefined }) }), /not a passing release manifest \(ok is null\)/);
    assert.throws(() => readDeployment(unset, { manifest: manifest({ ...release, chainId: "5042" }) }), /is for chain 5042, not FLOAT_MAINNET_EXPECTED_CHAIN_ID 5042002/);
    assert.throws(() => readDeployment(unset, { manifest: manifest({ ...release, bytecode: undefined }) }), /no bytecode.onchainRuntimeKeccak256/);
    assert.throws(() => readDeployment(unset, { manifest: manifest({ ...release, deployment: {} }) }), /no deployment.blockNumber/);
    assert.throws(() => readDeployment(unset, { manifest: manifest({ ...release, contract: {} }) }), /no contract.address/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid key is refused without echoing it", () => {
  const connection = { chain: undefined, transport: http("http://127.0.0.1:1") };
  const order = SECP256K1_HALF_ORDER * 2n + 1n;
  for (const scalar of [0n, order, order + 1n, 2n ** 256n - 1n]) {
    const key = numberToHex(scalar, { size: 32 });
    for (const raw of [key, key.slice(2)]) {
      assert.throws(
        () => walletFromEnv(connection, "FLOAT_AGENT_PRIVATE_KEY", { FLOAT_AGENT_PRIVATE_KEY: raw }),
        (error) => {
          assert.equal(error.message, "FLOAT_AGENT_PRIVATE_KEY is not a valid secp256k1 private key");
          assert.ok(!error.message.includes(scalar.toString()) && !error.message.includes(key.slice(2)));
          return true;
        },
      );
    }
  }
  assert.throws(
    () => walletFromEnv(connection, "FLOAT_SPONSOR_PRIVATE_KEY", { FLOAT_SPONSOR_PRIVATE_KEY: "0x1234" }),
    /^Error: FLOAT_SPONSOR_PRIVATE_KEY is not a valid secp256k1 private key$/,
  );
  assert.throws(() => walletFromEnv(connection, "FLOAT_SPONSOR_PRIVATE_KEY", {}), /FLOAT_SPONSOR_PRIVATE_KEY is required/);
  const valid = numberToHex(order - 1n, { size: 32 });
  assert.match(walletFromEnv(connection, "FLOAT_AGENT_PRIVATE_KEY", { FLOAT_AGENT_PRIVATE_KEY: valid }).account.address, /^0x[0-9a-fA-F]{40}$/);
});
