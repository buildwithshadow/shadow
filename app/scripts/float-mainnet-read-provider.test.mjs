import { findLogs } from './float-mainnet-cli.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { createPublicClient, encodeAbiParameters, keccak256, toBytes } from 'viem';
import { createReadProviderTransport } from './rpc-read-provider-transport.mjs';
import { connectCandidate, DOMAIN_NAME, DOMAIN_VERSION, SPEND_INTENT_TYPE_STRING } from './float-mainnet-config.mjs';

test('scoped clients cancel shared queue work without retrying it or cancelling another client', async () => {
  let enter, finish; const calls = [];
  const entered = new Promise(resolve => { enter = resolve; });
  const wire = new Promise((_, reject) => { finish = reject; });
  const transport = createReadProviderTransport({request: async ({method}) => {
    calls.push(method); if (method === 'eth_getCode') { enter(); return wire; } return '0x13b2';
  }}, {spacingMs: 0, queueOptions: {baseDelayMs: 0}});
  const controller = new AbortController();
  const retired = createPublicClient({transport: transport.withSignal(controller.signal)});
  const healthy = createPublicClient({transport});
  const first = assert.rejects(retired.request({method: 'eth_getCode'}), /retired request/);
  await entered;
  const queued = assert.rejects(retired.request({method: 'eth_call'}), /retired request/);
  const good = healthy.getChainId();
  controller.abort(new Error('retired request'));
  finish(Error('temporarily unavailable'));
  await Promise.all([first, queued]); assert.equal(await good, 5042);
  assert.deepEqual(calls, ['eth_getCode', 'eth_chainId']);
});

test('owned read provider serializes calls and refuses every broadcast method before dispatch', async () => {
  let active = 0, maxActive = 0; const methods = [];
  const client = createPublicClient({ transport: createReadProviderTransport({ request: async ({ method }) => {
    methods.push(method); active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setImmediate(resolve)); active--; return '0x1';
  } }, { spacingMs: 0 }) });
  await Promise.all([client.request({ method: 'eth_chainId' }), client.request({ method: 'eth_getCode' })]);
  assert.equal(maxActive, 1);
  for (const method of ['eth_sendRawTransaction','eth_sendTransaction','eth_signTypedData_v4','personal_sign']) await assert.rejects(client.request({ method }), /refuses/);
  assert.deepEqual(methods, ['eth_chainId','eth_getCode']);
});
test('owned read provider errors are not retried and never retain credential text', async () => {
  let calls = 0;
  const client = createPublicClient({ transport: createReadProviderTransport({ request: async () => {
    calls++; const error = new Error('wss://user:password@rpc.invalid/key-secret'); error.code = -32603; throw error;
  } }, { spacingMs: 0 }) });
  await assert.rejects(client.request({ method: 'eth_chainId' }, { retryCount: 5 }), error => {
    assert.doesNotMatch(inspect(error, { depth: 10 }), /password|key-secret/); return true;
  });
  assert.equal(calls, 1);
});
test('read provider connection still verifies runtime, domain and chain identity and cannot create a write connection', async () => {
  const deployment = { rpcUrl:'http://127.0.0.1:1', expectedChainId:5042n, address:'0x0000000000000000000000000000000000000001', runtimeHash:keccak256('0x6000'), readSpacingMs:0 };
  const constants = [keccak256(toBytes(DOMAIN_NAME)),keccak256(toBytes(DOMAIN_VERSION)),keccak256(toBytes(SPEND_INTENT_TYPE_STRING)),encodeAbiParameters([{type:'uint256'}],[5042n])];
  const calls=[]; let index=0;
  const provider={request:async({method})=>{calls.push(method);if(method==='eth_chainId')return '0x13b2';if(method==='eth_getCode')return '0x6000';if(method==='eth_call')return constants[index++];throw new Error('Unexpected method');}};
  await assert.rejects(connectCandidate(deployment,{readProvider:provider}),/read-only connection/);
  assert.equal(calls.length,0);
  const connected=await connectCandidate(deployment,{readOnly:true,readProvider:provider});
  assert.equal(connected.chainId,5042n); assert.equal(index,4);
  await assert.rejects(connectCandidate({...deployment,runtimeHash:keccak256('0x6001')},{readOnly:true,readProvider:provider}),/hashes to/);
  const wrong={request:async()=> '0x1'};
  await assert.rejects(connectCandidate(deployment,{readOnly:true,readProvider:wrong}),/not 5042/);
});

test('owned read provider retains bounded quota retries in the explicit read queue', async () => {
  let calls = 0;
  const client = createPublicClient({ transport: createReadProviderTransport({ request: async () => {
    if (++calls < 3) { const error = new Error('rate limit exceeded; wss://rpc.invalid/private-detail'); error.code = -32005; throw error; }
    return '0x1';
  } }, { spacingMs: 0, queueOptions: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }) });
  assert.equal(await client.getChainId(), 1); assert.equal(calls, 3);
});
test('read provider rejects invalid parameters without dispatch or leaking clone errors', async () => {
  let calls = 0;
  const client = createPublicClient({ transport: createReadProviderTransport({ request: async () => { calls++; return '0x1'; } }, { spacingMs: 0 }) });
  for (const params of [null, {}, [() => 'private-secret']]) {
    await assert.rejects(client.request({ method: 'eth_call', params }), error => {
      assert.doesNotMatch(inspect(error, { depth: 10 }), /private-secret/); return true;
    });
  }
  assert.equal(calls, 0);
});

test('explicit range limits still split canonical scans instead of retrying the same range', async () => {
  const ranges = [], successful = [];
  const client = createPublicClient({ transport: createReadProviderTransport({ request: async ({method,params}) => {
    assert.equal(method,'eth_getLogs'); const {fromBlock,toBlock}=params[0];
    const from=BigInt(fromBlock),to=BigInt(toBlock);ranges.push([from,to]);
    if(to-from+1n>20n){const error=new Error('block range exceeds provider maximum wss://rpc.invalid/private-secret');error.code=-32005;throw error;}
    successful.push([from,to]);return [];
  } }, {spacingMs:0,queueOptions:{maxAttempts:3,baseDelayMs:0,maxDelayMs:0}}) });
  assert.deepEqual(await findLogs({client,address:'0x0000000000000000000000000000000000000001'},undefined,undefined,0n,99n),[]);
  assert.deepEqual(ranges.slice(0,3),[[0n,99n],[0n,49n],[0n,24n]]);
  let cursor=0n;for(const [from,to]of successful){assert.equal(from,cursor);cursor=to+1n;}assert.equal(cursor,100n);
});

test('deterministic log errors retain their exclusion from retries before sanitization', async () => {
  for(const [message,attempts] of [['pruned history unavailable',1],['internal error: invalid params',1],['internal error',3]]) {
    let calls=0;
    const client=createPublicClient({transport:createReadProviderTransport({request:async()=>{calls++;const error=new Error(message);error.code=-32603;throw error;}},{spacingMs:0,queueOptions:{maxAttempts:3,baseDelayMs:0,maxDelayMs:0}})});
    await assert.rejects(client.request({method:'eth_getLogs',params:[{}]}));assert.equal(calls,attempts,message);
  }
});
