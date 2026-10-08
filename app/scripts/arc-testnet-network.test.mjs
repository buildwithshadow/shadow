import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_RPC_URL, arcTestnetRpcUrl, arcTestnetWalletParameters, arcTestnetConnectionHelp } from '../arcTestnetNetwork.mjs';

test('fresh wallet setup supplies Arc testnet with public endpoints and native gas decimals', () => {
  const params = arcTestnetWalletParameters();
  assert.equal(Number(params.chainId), ARC_TESTNET_CHAIN_ID);
  assert.deepEqual(params.rpcUrls, ['https://rpc.testnet.arc.io']);
  assert.deepEqual(params.blockExplorerUrls, ['https://explorer.testnet.arc.io']);
  assert.deepEqual(params.nativeCurrency, { name: 'USDC', symbol: 'USDC', decimals: 18 });
  params.rpcUrls[0] = 'https://private.example/key';
  params.nativeCurrency.decimals = 6;
  assert.equal(arcTestnetWalletParameters().rpcUrls[0], ARC_TESTNET_RPC_URL);
  assert.equal(arcTestnetWalletParameters().nativeCurrency.decimals, 18);
});

test('known legacy public endpoints migrate without overriding a configured private or mainnet endpoint', () => {
  for (const provider of ['', 'blockdaemon.', 'drpc.', 'quicknode.']) {
    assert.equal(arcTestnetRpcUrl(` https://rpc.${provider}testnet.arc.network/ `), `https://rpc.${provider}testnet.arc.io`);
  }
  for (const url of ['https://private.example/token', 'https://rpc.mainnet.arc.io', 'https://rpc.testnet.arc.network/custom', 'https://rpc.testnet.arc.network?key=private']) {
    assert.equal(arcTestnetRpcUrl(url), url);
  }
  assert.equal(arcTestnetRpcUrl(''), ARC_TESTNET_RPC_URL);
});

test('nested wallet HTTP403 gets recovery guidance without echoing the server response', () => {
  const cause = new Error('HTTP request failed. Status: 403. URL: https://rpc.testnet.arc.network/\n<html>private server details</html>');
  const help = arcTestnetConnectionHelp(new Error('RPC request failed', { cause }));
  assert.match(help, /Settings > Modify RPC URL > Arc Testnet/);
  assert.match(help, /Check any saved pending transaction/);
  assert.doesNotMatch(help, /private server details|<html>/);
  const loop = { message: cause.message }; loop.cause = loop;
  assert.equal(arcTestnetConnectionHelp(loop), help);
});

test('a declined wallet request or an unrelated provider error does not get misdiagnosed as an RPC outage', () => {
  assert.equal(arcTestnetConnectionHelp(new Error('User rejected the request')), null);
  assert.equal(arcTestnetConnectionHelp(new Error('HTTP 403 from https://provider.example/result')), null);
  assert.equal(arcTestnetConnectionHelp(new Error('RPC policy declined at https://rpc.testnet.arc.io')), null);
});

test('a standalone copied builder example preserves endpoint migration without depending on the app tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-builder-network-'));
  try {
    const target = join(dir, 'network.mjs');
    copyFileSync(new URL('../../examples/float-v2-signed-spend/network.mjs', import.meta.url), target);
    const example = await import(pathToFileURL(target).href);
    for (const value of [undefined, 'https://rpc.testnet.arc.network/', 'https://rpc.drpc.testnet.arc.network', 'https://private.example/token']) {
      assert.equal(example.arcTestnetRpcUrl(value), arcTestnetRpcUrl(value));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
