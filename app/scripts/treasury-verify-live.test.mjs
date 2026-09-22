import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LEPTON_M1_DEPLOYMENTS, leptonHistoricalProofsForJson } from "../leptonM1Config.js";

// Run the actual top-level CLI, including ABI decoding, JSON output and exit
// status, in a child with a closed network stub. No RPC server, wallet or ports.
const fixture = `
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, parseAbi } from ${JSON.stringify(import.meta.resolve("viem"))};
import { LEPTON_M1_DEPLOYMENTS } from ${JSON.stringify(new URL("../leptonM1Config.js", import.meta.url).href)};
const address = (n) => "0x" + n.toString(16).padStart(40, "0");
const hash = (n) => "0x" + n.toString(16).padStart(64, "0");
const [float, attestor, enforcer, adapter, sink, operator, provider, usdc] = [1,2,3,4,5,6,7,8].map(address);
const [createTx, allowedTx, blockedTx, settlementTx, bindTx, allowedAction, blockedAction, requestHash] = [1,2,3,4,5,6,7,8].map(hash);
Object.assign(process.env, {
  ARC_RPC_URL: "https://rpc.example.test", TREASURY_VERIFY_FLOAT_API_URL: "https://float.example.test",
  SHADOW_FLOAT: float, LEPTON_ATTESTOR: attestor, LEPTON_ENFORCER: enforcer,
  LEPTON_MORPHO_ADAPTER: adapter, LEPTON_MORPHO_VAULT_SINK: sink,
  TREASURY_OPERATOR_ADDRESS: operator, TREASURY_OPERATOR_PROVIDER: provider, ARC_USDC: usdc,
  TREASURY_VERIFY_CREATE_MANDATE_TX: createTx, TREASURY_VERIFY_ALLOWED_TX: allowedTx,
  TREASURY_VERIFY_BLOCKED_TX: blockedTx, TREASURY_VERIFY_X402_SETTLEMENT_TX: settlementTx,
  TREASURY_VERIFY_FLOAT_BIND_TX: bindTx, TREASURY_VERIFY_ALLOWED_ACTION_HASH: allowedAction,
  TREASURY_VERIFY_BLOCKED_ACTION_HASH: blockedAction, TREASURY_VERIFY_FLOAT_REQUEST_HASH: requestHash,
  TREASURY_VERIFY_ALLOWED_AMOUNT_ATOMIC: "100000", TREASURY_VERIFY_BLOCKED_AMOUNT_ATOMIC: "300000",
  TREASURY_VERIFY_X402_AMOUNT_ATOMIC: "1000", TREASURY_VERIFY_FEE_ATOMIC: "10",
});
const abi = parseAbi([
  "function adapterBondUSDC() view returns (uint256)",
  "function bondUSDC(address) view returns (uint256)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalAvailableCreditUSDC() view returns (uint256)",
  "function receiptByActionHash(bytes32) view returns (bytes32)",
  "function receiptByRequestHash(bytes32) view returns (bytes32)",
  "function getReceiptDecision(bytes32) view returns (uint256,uint256,uint8,uint8,bytes32)",
  "function getReceiptParties(bytes32) view returns (address,address,address,address,address)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event X402PaymentBound(uint256 indexed receiptId,bytes32 indexed requestHash,bytes32 x402Hash,address indexed provider,uint256 amountUSDC,address facilitator)",
]);
const transfer = (to, value) => ({
  address: usdc,
  topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: operator, to } }),
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});
const binding = {
  address: float,
  topics: encodeEventTopics({ abi, eventName: "X402PaymentBound", args: { receiptId: 1n, requestHash, provider } }),
  data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }], [settlementTx, 1000n, operator]),
};
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).hostname === "float.example.test") {
    return Response.json({
      receipts: ["SPEND_ALLOWED", "PROVIDER_PAID", "FEE_ACCRUED", "DEBT_OPENED"].map(receiptType => ({
        requestHash, receiptType, providerAmountUSDC: "1000", feeUSDC: "10", debtOpenedUSDC: "1010",
      })),
      proofChecks: { hasX402BoundSpend: true, feeMechanicsVisible: true },
    });
  }
  if (new URL(url).hostname !== "rpc.example.test") throw new Error("unexpected network URL: " + url);
  const request = JSON.parse(input instanceof Request ? await input.text() : String(init.body));
  let result;
  if (request.method === "eth_call") {
    const { functionName, args } = decodeFunctionData({ abi, data: request.params[0].data });
    const values = {
      adapterBondUSDC: 10000000n, bondUSDC: 10000000n,
      treasuryBalanceUSDC: 1000000n, totalAvailableCreditUSDC: 500000n,
      receiptByRequestHash: hash(11),
    };
    if (functionName === "receiptByActionHash") values[functionName] = args[0] === allowedAction ? hash(9) : hash(10);
    if (functionName === "getReceiptDecision") values[functionName] = args[0] === hash(9) ? [1n,100000n,0,0,hash(12)] : [1n,300000n,1,3,hash(12)];
    if (functionName === "getReceiptParties") values[functionName] = [operator,operator,enforcer,usdc,adapter];
    result = encodeFunctionResult({ abi, functionName, result: values[functionName] });
  } else if (request.method === "eth_getTransactionByHash") {
    const historical = LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey;
    result = { hash: request.params[0], to: usdc, type: "0x0",
      input: request.params[0] === historical.txHash ? "0x1234" + historical.v4StyleAdapter.slice(2).padStart(64, "0") : "0x" };
  } else if (request.method === "eth_getTransactionReceipt") {
    const tx = request.params[0];
    const logs = tx === allowedTx ? [transfer(sink, 100000n)]
      : tx === settlementTx ? [transfer(provider, 1000n)]
      : tx === bindTx ? [binding]
      : tx === blockedTx && process.env.TEST_LEAK_TRANSFER === "1" ? [transfer(sink, 1n)] : [];
    result = { status: "0x1", logs, blockNumber: "0x1", transactionHash: tx, type: "0x0" };
  } else throw new Error("unexpected RPC method: " + request.method);
  return Response.json({ jsonrpc: "2.0", id: request.id, result });
};
await import(${JSON.stringify(new URL("./treasury-verify-live.mjs", import.meta.url).href)});
`;

test("proof JSON serialization preserves the bigint chain-read configuration", () => {
  const report = JSON.parse(JSON.stringify(leptonHistoricalProofsForJson()));
  assert.equal(report.circlePasskey.blockNumber, "47710773");
  assert.equal(LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.blockNumber, 47710773n);
});

for (const failedCheck of [false, true]) {
  test(`the full Treasury CLI emits valid JSON and exits ${failedCheck ? "1 on a failed check" : "0 when all checks pass"}`, () => {
    const run = spawnSync(process.execPath, ["--input-type=module", "--eval", fixture], {
      encoding: "utf8", timeout: 10_000,
      env: { TEST_LEAK_TRANSFER: failedCheck ? "1" : "0" },
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, failedCheck ? 1 : 0, run.stderr || run.stdout);
    assert.doesNotMatch(run.stderr, /BigInt|TypeError/);
    const report = JSON.parse(run.stdout);
    assert.equal(report.ok, !failedCheck);
    assert.equal(report.historicalProofs.circlePasskey.blockNumber, "47710773");
    assert.equal(report.historicalProofs.circlePasskey.txHash, LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.txHash);
    assert.equal(report.amounts.allowedAllocationUSDC, "0.1");
    assert.ok(report.checks.length > 20);
    assert.ok(report.checks.every((entry) => typeof entry.detail === "string"));
    if (failedCheck) {
      assert.deepEqual(report.checks.filter((entry) => !entry.ok).map((entry) => entry.check), ["blocked allocation moved no vault USDC"]);
    } else {
      assert.ok(report.checks.every((entry) => entry.ok));
    }
  });
}
