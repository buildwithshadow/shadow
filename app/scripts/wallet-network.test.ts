import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureWalletChain, walletErrorCode, walletRequestHelp, type WalletRequester } from '../src/walletNetwork.ts';
import { candidateErrorMessage } from '../src/candidateFunding.ts';
import { arcTestnetWalletParameters } from '../arcTestnetNetwork.mjs';

const chain = arcTestnetWalletParameters();
function wallet(respond: (method: string, params?: unknown[]) => unknown) {
  const calls: Array<{ method: string; params?: unknown[] }> = [];
  const provider: WalletRequester = { async request(args) { calls.push(args); return respond(args.method, args.params); } };
  return { provider, calls };
}

test('an already selected chain needs no add or switch request', async () => {
  const { provider, calls } = wallet(() => chain.chainId);
  assert.equal(await ensureWalletChain(provider, chain), 5042002);
  assert.deepEqual(calls.map(x => x.method), ['eth_chainId']);
});

test('a successful switch is verified against the wallet actual chain', async () => {
  let selected = '0x1';
  const { provider, calls } = wallet(method => {
    if (method === 'eth_chainId') return selected;
    selected = chain.chainId;
    return null;
  });
  assert.equal(await ensureWalletChain(provider, chain), 5042002);
  assert.deepEqual(calls[1], { method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainId }] });
});

for (const code of [4902, '4902']) test(`nested missing chain code ${typeof code} adds and explicitly selects the chain`, async () => {
  let added = false, selected = '0x1';
  const { provider, calls } = wallet((method, params) => {
    if (method === 'eth_chainId') return selected;
    if (method === 'wallet_switchEthereumChain') {
      if (!added) throw { code: -32603, data: { originalError: { code } } };
      selected = chain.chainId;
    } else if (method === 'wallet_addEthereumChain') {
      assert.deepEqual(params, [chain]); added = true;
      // Adding a network does not select it in all extensions.
    }
    return null;
  });
  assert.equal(await ensureWalletChain(provider, chain), 5042002);
  assert.deepEqual(calls.map(x => x.method), ['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId']);
});

test('no second switch is needed if adding selected the network', async () => {
  let selected = '0x1';
  const { provider, calls } = wallet(method => {
    if (method === 'eth_chainId') return selected;
    if (method === 'wallet_switchEthereumChain') throw { code: 4902 };
    selected = chain.chainId;
    return null;
  });
  assert.equal(await ensureWalletChain(provider, chain), 5042002);
  assert.equal(calls.filter(x => x.method === 'wallet_switchEthereumChain').length, 1);
});

for (const code of [4001, -32002, 4100, 4200, 4900, -32603]) test(`code ${code} does not automatically retry or add a network`, async () => {
  const failure = { code };
  const { provider, calls } = wallet(method => { if (method === 'eth_chainId') return '0x1'; throw failure; });
  await assert.rejects(ensureWalletChain(provider, chain), e => e === failure);
  assert.equal(calls.length, 2);
});

test('declining the add request stops immediately', async () => {
  const { provider, calls } = wallet(method => {
    if (method === 'eth_chainId') return '0x1';
    throw { code: method === 'wallet_addEthereumChain' ? 4001 : 4902 };
  });
  await assert.rejects(ensureWalletChain(provider, chain), e => walletErrorCode(e) === 4001);
  assert.equal(calls.length, 3);
});

test('a success response cannot mark the wrong network as connected', async () => {
  const { provider } = wallet(method => method === 'eth_chainId' ? '0x1' : null);
  await assert.rejects(ensureWalletChain(provider, chain), /still on another network/);
});

test('invalid target and wallet chain replies stop without a switch', async () => {
  for (const value of [null, 5042002, '5042002', 'garbage']) {
    const { provider, calls } = wallet(() => value);
    await assert.rejects(ensureWalletChain(provider, chain), /did not report/);
    assert.equal(calls.length, 1);
  }
  const { provider, calls } = wallet(() => '0x1');
  await assert.rejects(ensureWalletChain(provider, { ...chain, chainId: 'no' }), /Invalid target/);
  assert.equal(calls.length, 0);
});

test('plain provider errors are actionable without leaking response bodies', () => {
  for (const [code, help] of [[4001, /declined/], [-32002, /already waiting/], [4100, /not authorized/], [4200, /does not support/], [4900, /disconnected/], [4902, /has not been added/], [-32603, /code -32603/]] as const) {
    const message = walletRequestHelp({ code, message: 'SECRET server payload', data: '<html>private</html>' });
    assert.match(message!, help);
    assert.doesNotMatch(message!, /SECRET|private|<html>/);
  }
  assert.equal(walletRequestHelp(new Error('ordinary app error')), null);
});

test('bounded nested code discovery handles cycles and preserves explicit rejection', () => {
  const cycle: Record<string, unknown> = { code: -32603 }; cycle.cause = cycle;
  assert.equal(walletErrorCode(cycle), -32603);
  assert.equal(walletErrorCode({ code: 4001, cause: { code: 4902 } }), 4001);
  assert.equal(walletErrorCode({ cause: { error: { data: { originalError: { code: -32002 } } } } }), -32002);
});


test('public RPC and simulation codes are not misattributed to a wallet request', () => {
  for (const code of [-32002, -32601, -32603, 3]) {
    const rpcFailure = Object.assign(new Error('RPC simulation failed: execution reverted'), { code });
    assert.equal(candidateErrorMessage(rpcFailure), 'RPC simulation failed: execution reverted');
    assert.doesNotMatch(candidateErrorMessage({ code }), /wallet|waiting|pending transaction/);
  }
});
