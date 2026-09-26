import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { ContractFunctionRevertedError, createPublicClient, encodeErrorResult } from "viem";
import { createRpcReadTransport } from "./rpc-read-transport.mjs";
import { isTransientRpcReadError } from "./rpc-read-queue.mjs";

const queueOptions = { spacingMs: 0, baseDelayMs: 1, maxDelayMs: 4, random: () => 0, sleep: async () => {} };
const reply = (body, result) => Response.json({ jsonrpc: "2.0", id: body.id, result });
const failure = (body, message, status = 429) => Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message } }, { status });

test("monitor transport serializes concurrent reads and retries a quota response a bounded number of times", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const methods = [];
  const delays = [];
  const client = createPublicClient({ transport: createRpcReadTransport("https://rpc.example", {
    queueOptions: { ...queueOptions, maxAttempts: 3, sleep: async (delay) => delays.push(delay) },
    fetchFn: async (_url, options) => {
      const body = JSON.parse(options.body);
      methods.push(body.method);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return ++calls === 1 ? failure(body, "rate limit exceeded") : reply(body, "0x1");
    },
  }) });
  const results = await Promise.all([client.request({ method: "eth_chainId" }), client.request({ method: "eth_blockNumber" })]);
  assert.deepEqual(results, ["0x1", "0x1"]);
  assert.equal(maxActive, 1);
  assert.deepEqual(methods, ["eth_chainId", "eth_chainId", "eth_blockNumber"]);
  assert.deepEqual(delays, [1]);
});

test("quota exhaustion preserves method and sanitized provider detail, without stacked retries", async () => {
  let calls = 0;
  const client = createPublicClient({ transport: createRpcReadTransport("https://user:password@rpc.example/credential?token=secret", {
    queueOptions: { ...queueOptions, maxAttempts: 3 },
    fetchFn: async (_url, options) => {
      calls++;
      return failure(JSON.parse(options.body), "rate limit exceeded at https://user:password@rpc.example/credential?token=secret");
    },
  }) });
  await assert.rejects(client.request({ method: "eth_call", params: [{ data: "0x1234" }, "latest"] }), (error) => {
    assert.match(error.shortMessage, /RPC read eth_call failed/);
    assert.match(error.shortMessage, /rate limit exceeded at https:\/\/rpc.example\/\[redacted\]/);
    for (const value of [error.shortMessage, error.message, error.details, JSON.stringify(error), inspect(error, { depth: 10 })]) {
      assert.doesNotMatch(value, /password|credential|secret|0x1234|Request body/);
    }
    assert.equal(error.cause.code, -32005);
    assert.equal(isTransientRpcReadError(error), true);
    assert.equal(error.cause.cause, undefined);
    return true;
  });
  assert.equal(calls, 3);
});

test("sanitized causes preserve custom-error decoding across RPC revert formats", async () => {
  const address = "0x0000000000000000000000000000000000000001";
  const abi = [
    { type: "function", name: "peek", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "error", name: "SponsorDenied", inputs: [{ name: "sponsor", type: "address" }] },
  ];
  const data = encodeErrorResult({ abi, errorName: "SponsorDenied", args: [address] });
  for (const code of [3, -32603, -32000]) {
    for (const payload of [data, { data, irrelevant: "must-not-propagate" }]) {
      let calls = 0;
      const client = createPublicClient({ transport: createRpcReadTransport("https://user:password@rpc.example/credential?token=secret", {
        queueOptions,
        fetchFn: async (_url, options) => {
          calls++;
          const body = JSON.parse(options.body);
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code, message: "execution reverted", data: payload } });
        },
      }) });
      await assert.rejects(client.readContract({ address, abi, functionName: "peek" }), (error) => {
        const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
        assert.equal(reverted?.data?.errorName, "SponsorDenied", `RPC code ${code}`);
        assert.deepEqual(reverted.data.args, [address]);
        assert.doesNotMatch(inspect(error, { depth: 20 }), /password|credential|secret|must-not-propagate|Request body/);
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test("a revert with a reason and no bytes remains a contract refusal after sanitizing", async () => {
  const client = createPublicClient({ transport: createRpcReadTransport("https://rpc.example", {
    queueOptions,
    fetchFn: async (_url, options) => Response.json({
      jsonrpc: "2.0", id: JSON.parse(options.body).id,
      error: { code: 3, message: "execution reverted: sponsor not allowed" },
    }),
  }) });
  const abi = [{ type: "function", name: "peek", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
  await assert.rejects(client.readContract({ address: "0x0000000000000000000000000000000000000001", abi, functionName: "peek" }), (error) => {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    assert.equal(reverted?.reason, "execution reverted: sponsor not allowed");
    return true;
  });
});

test("explicit range errors are not retried by the transport and retain their cause for splitting", async () => {
  let calls = 0;
  const client = createPublicClient({ transport: createRpcReadTransport("https://rpc.example", {
    queueOptions,
    fetchFn: async (_url, options) => {
      calls++;
      return failure(JSON.parse(options.body), "block range exceeds maximum", 200);
    },
  }) });
  await assert.rejects(client.request({ method: "eth_getLogs", params: [{}] }), (error) => {
    assert.match(error.shortMessage, /block range exceeds maximum/);
    assert.equal(error.cause.code, -32005);
    return true;
  });
  assert.equal(calls, 1);
});

test("the read-only transport refuses sends and signatures before calling the network", async () => {
  let calls = 0;
  const client = createPublicClient({ transport: createRpcReadTransport("https://rpc.example", {
    queueOptions,
    fetchFn: async () => { calls++; throw new Error("unexpected fetch"); },
  }) });
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_signTypedData_v4", "personal_sign"]) {
    await assert.rejects(client.request({ method, params: [] }), new RegExp(`read-only RPC transport refuses ${method}`));
  }
  assert.equal(calls, 0);
});
