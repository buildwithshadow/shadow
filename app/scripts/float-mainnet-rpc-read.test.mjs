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

test("candidate connections pace reads even in write mode, while broadcasts are never retried", async (t) => {
  const { createServer } = await import("node:http");
  const { encodeFunctionResult, toFunctionSelector, keccak256, toBytes } = await import("viem");
  const { connectCandidate, walletFromEnv, floatAbi, DOMAIN_NAME, DOMAIN_VERSION, SPEND_INTENT_TYPE_STRING } = await import("./float-mainnet-config.mjs");
  const identity = {
    NAME_HASH: keccak256(toBytes(DOMAIN_NAME)), VERSION_HASH: keccak256(toBytes(DOMAIN_VERSION)),
    SPEND_INTENT_TYPEHASH: keccak256(toBytes(SPEND_INTENT_TYPE_STRING)), deploymentChainId: 5042002n,
  };
  let active = 0, maximum = 0, logs = 0, sends = 0, nonces = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    let result, error;
    if (body.method === "eth_chainId") result = "0x4cef52";
    else if (body.method === "eth_getCode") result = "0x1234";
    else if (body.method === "eth_call") {
      const name = Object.keys(identity).find((name) => toFunctionSelector(`${name}()`) === body.params[0].data);
      result = encodeFunctionResult({ abi: floatAbi, functionName: name, result: identity[name] });
    } else if (body.method === "eth_getLogs") {
      if (++logs === 1) error = { code: -32005, message: "rate limit exceeded" }; else result = [];
    } else if (body.method === "eth_getTransactionCount") {
      if (++nonces === 1) error = { code: -32005, message: "rate limit exceeded" }; else result = "0x2";
    } else if (body.method === "eth_blockNumber") result = "0x10";
    else if (body.method === "eth_sendRawTransaction") { sends++; error = { code: -32005, message: "rate limit exceeded" }; }
    else error = { code: -32601, message: "unsupported test method" };
    active--; res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(error ? { error } : { result }) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const deployment = { rpcUrl: `http://127.0.0.1:${server.address().port}`, expectedChainId: 5042002n, address: "0x0000000000000000000000000000000000000001" };
  const connection = await connectCandidate(deployment);
  const [found, head] = await Promise.all([connection.client.getLogs({ fromBlock: 0n, toBlock: 16n }), connection.client.getBlockNumber()]);
  assert.deepEqual(found, []); assert.equal(head, 16n); assert.equal(logs, 2); assert.equal(maximum, 1);
  // Public deterministic test key, never a funded wallet.
  const { wallet } = walletFromEnv(connection, "TEST_KEY", { TEST_KEY: `0x${"0".repeat(63)}1` });
  const prepared = await wallet.prepareTransactionRequest({ to: deployment.address, parameters: ["nonce"] });
  assert.equal(prepared.nonce, 2); assert.equal(nonces, 2, "real nonce preparation retries the transient quota");
  logs = 0; maximum = 0;
  const walletReads = await Promise.all([
    wallet.request({ method: "eth_getLogs", params: [{}] }),
    wallet.request({ method: "eth_blockNumber" }),
  ]);
  assert.deepEqual(walletReads, [[], "0x10"]);
  assert.equal(logs, 2, "wallet preparation reads retry quotas");
  assert.equal(maximum, 1, "wallet preparation reads are serialized");
  await assert.rejects(wallet.sendRawTransaction({ serializedTransaction: "0x1234" }));
  assert.equal(sends, 1);
  await assert.rejects(connection.client.request({ method: "eth_sendRawTransaction", params: ["0x1234"] }), /read-only RPC transport refuses/);
  const readOnly = await connectCandidate(deployment, { readOnly: true });
  const readonlyWallet = walletFromEnv(readOnly, "TEST_KEY", { TEST_KEY: `0x${"0".repeat(63)}1` }).wallet;
  await assert.rejects(readonlyWallet.sendRawTransaction({ serializedTransaction: "0x1234" }), /read-only RPC transport refuses/);
  assert.equal(sends, 1);
});


test("read transport fails over a quota-limited provider without retrying writes", async () => {
  const seen = [];
  const client = createPublicClient({ transport: createRpcReadTransport("https://primary.example", {
    fallbackUrls: ["https://secondary.example"], expectedChainId: 5042002,
    queueOptions: { ...queueOptions, maxAttempts: 2 },
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body); seen.push([String(url), body.method]);
      if (String(url).includes("primary")) return failure(body, "rate limit exceeded");
      return reply(body, body.method === "eth_chainId" ? "0x4cef52" : "0x6000");
    },
  }) });
  assert.equal(await client.getCode({address: "0x0000000000000000000000000000000000000001"}), "0x6000");
  assert.ok(seen.some(([url]) => url.includes("secondary")));
  const count=seen.length;
  await assert.rejects(client.request({method:"eth_sendRawTransaction",params:["0x00"]}), /refuses/);
  assert.equal(seen.length,count);
});

test("fallback rejects the wrong chain before reading contract code", async () => {
  const seen=[];
  const client=createPublicClient({transport:createRpcReadTransport('https://primary.example',{
    fallbackUrls:['https://secondary.example'], expectedChainId:5042002,
    queueOptions:{...queueOptions,maxAttempts:3},
    fetchFn:async(url,options)=>{const body=JSON.parse(options.body);seen.push([String(url),body.method]);return String(url).includes('primary')?failure(body,'rate limit exceeded'):reply(body,'0x1');},
  })});
  await assert.rejects(client.getCode({address:'0x0000000000000000000000000000000000000001'}),/unexpected chain ID/);
  assert.deepEqual(seen.map(x=>x[1]),['eth_chainId','eth_chainId']);
});

test("fallback retains bounded attempts when every provider is unavailable", async () => {
  let calls=0;
  const client=createPublicClient({transport:createRpcReadTransport('https://primary.example',{
    fallbackUrls:['https://secondary.example'],expectedChainId:5042002,queueOptions:{...queueOptions,maxAttempts:3},
    fetchFn:async(_url,options)=>{calls++;return failure(JSON.parse(options.body),'rate limit exceeded');},
  })});
  await assert.rejects(client.request({method:'eth_blockNumber'}),/rate limit/);
  assert.equal(calls,3);
});


test("internal log errors can fail over without changing the requested range", async () => {
 const requests=[];
 const client=createPublicClient({transport:createRpcReadTransport('https://primary.example',{
  fallbackUrls:['https://secondary.example'],expectedChainId:5042002,queueOptions:{...queueOptions,maxAttempts:2},
  fetchFn:async(url,options)=>{
   const body=JSON.parse(options.body);requests.push({url:String(url),body});
   if(body.method==='eth_chainId')return reply(body,'0x4cef52');
   if(String(url).includes('primary'))return Response.json({jsonrpc:'2.0',id:body.id,error:{code:-32603,message:'internal error'}});
   return reply(body,[]);
  },
 })});
 const params=[{fromBlock:'0x100',toBlock:'0x200'}];
 assert.deepEqual(await client.request({method:'eth_getLogs',params}),[]);
 const logs=requests.filter(x=>x.body.method==='eth_getLogs');
 assert.equal(logs.length,2);assert.ok(logs[1].url.includes('secondary'));
 assert.deepEqual(logs.map(x=>x.body.params),[params,params]);
});

test("pruned history is not replaced with an empty successful fallback", async () => {
 let secondaryCalls=0,logCalls=0;
 const client=createPublicClient({transport:createRpcReadTransport('https://primary.example',{
  fallbackUrls:['https://secondary.example'],expectedChainId:5042002,queueOptions:{...queueOptions,maxAttempts:3},
  fetchFn:async(url,options)=>{
   const body=JSON.parse(options.body);
   if(String(url).includes('secondary')){secondaryCalls++;return reply(body,[]);}
   if(body.method==='eth_chainId')return reply(body,'0x4cef52');
   logCalls++;return Response.json({jsonrpc:'2.0',id:body.id,error:{code:4444,message:'internal error: pruned history unavailable'}});
  },
 })});
 await assert.rejects(client.request({method:'eth_getLogs',params:[{}]}),/pruned history/);
 assert.equal(logCalls,1);assert.equal(secondaryCalls,0);
});

for (const message of ["header not found", "block not found", "state unavailable", "internal error: unknown historical failure"]) {
 test(`explicit RPC history failure is not retried: ${message}`, async () => {
  let logCalls = 0, secondaryCalls = 0;
  const client = createPublicClient({transport: createRpcReadTransport('https://primary.example', {
   fallbackUrls: ['https://secondary.example'], expectedChainId: 5042002,
   queueOptions: {...queueOptions, maxAttempts: 3},
   fetchFn: async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes('secondary')) { secondaryCalls++; return reply(body, []); }
    if (body.method === 'eth_chainId') return reply(body, '0x4cef52');
    logCalls++;
    return Response.json({jsonrpc: '2.0', id: body.id, error: {code: -32603, message}});
   },
  })});
  await assert.rejects(client.request({method: 'eth_getLogs', params: [{}]}));
  assert.equal(logCalls, 1);
  assert.equal(secondaryCalls, 0);
 });
}
