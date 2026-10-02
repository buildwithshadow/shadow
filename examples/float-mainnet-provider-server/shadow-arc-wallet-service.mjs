import { createRequire } from 'node:module';

const { createPublicClient, erc20Abi, formatUnits, getAddress, http, zeroAddress } =
  createRequire(new URL('../../app/package.json', import.meta.url))('viem');
const USDC = '0x3600000000000000000000000000000000000000';
const HASH = /^0x[0-9a-fA-F]{64}$/;
const REQUEST = /^arc-wallet:([0-9a-f]{32}):(0x[0-9a-fA-F]{40})$/;
const NETWORKS = {
  5042: ['https://rpc.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io'],
  5042002: ['https://rpc.testnet.arc.io', 'https://rpc.blockdaemon.testnet.arc.io'],
};

export function walletReportAddress(requestId) {
  if (typeof requestId !== 'string') return null;
  const match = REQUEST.exec(requestId);
  if (!match) return null;
  try { const address = getAddress(match[2]); return address === zeroAddress ? null : address; }
  catch { return null; }
}

// Public, read-only report. Preparation occurs before provider acceptance; the
// provider server freezes these bytes under the spend digest for paid recovery.
export function createShadowArcWalletService({ chainId = 5042, clients, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!NETWORKS[chainId] || !Number.isInteger(chainId)) throw new Error('wallet report supports Arc mainnet or testnet only');
  clients ??= NETWORKS[chainId].map(url => createPublicClient({ transport: http(url, { timeout: 15_000, retryCount: 0 }) }));
  if (!Array.isArray(clients) || clients.length !== 2 || clients[0] === clients[1]) throw new Error('two separate read clients required');
  const service = async () => { throw new Error('Arc wallet report must be prepared before acceptance'); };
  service.validatePrepared = async ({ requestId, result }) => {
    const report = JSON.parse(Buffer.from(result).toString('utf8'));
    if (report.kind !== 'shadow-arc-wallet-balance-report' || report.requestId !== requestId || report.chainId !== chainId ||
        report.address !== walletReportAddress(requestId) || !/^(0|[1-9][0-9]*)$/.test(report.block?.number ?? '') ||
        !HASH.test(report.block?.hash ?? '') || !/^(0|[1-9][0-9]*)$/.test(report.block?.timestamp ?? '')) {
      throw new Error('prepared wallet report identity is invalid');
    }
    const number = BigInt(report.block.number), timestamp = BigInt(report.block.timestamp);
    if (BigInt(now()) < timestamp || BigInt(now()) - timestamp > 300n) throw new Error('prepared wallet report expired before acceptance');
    await Promise.all(clients.map(async c => {
      if (await c.getChainId() !== chainId || await c.getBlockNumber({ cacheTime: 0 }) < number + 20n) throw new Error('prepared wallet report network or confirmation changed');
      const b = await c.getBlock({ blockNumber: number });
      if (b.number !== number || b.hash?.toLowerCase() !== report.block.hash.toLowerCase() || b.timestamp !== timestamp) {
        throw new Error('prepared wallet report is no longer canonical');
      }
    }));
    if (BigInt(now()) - timestamp > 300n) throw new Error('prepared wallet report expired during validation');
  };
  service.prepare = async ({ requestId }) => {
    const address = walletReportAddress(requestId);
    if (!address) return null;
    const ids = await Promise.all(clients.map(c => c.getChainId()));
    if (ids.some(id => id !== chainId)) throw new Error('wallet report RPC network mismatch');
    const heads = await Promise.all(clients.map(c => c.getBlockNumber({ cacheTime: 0 })));
    if (heads.some(h => typeof h !== 'bigint' || h < 20n)) throw new Error('wallet report has no confirmed block');
    const blockNumber = (heads[0] < heads[1] ? heads[0] : heads[1]) - 20n;
    const blocks = await Promise.all(clients.map(c => c.getBlock({ blockNumber })));
    const checkBlocks = bs => {
      if (bs.some(b => b.number !== blockNumber || !HASH.test(b.hash ?? '') || typeof b.timestamp !== 'bigint') ||
          bs[0].hash.toLowerCase() !== bs[1].hash.toLowerCase() || bs[0].timestamp !== bs[1].timestamp) {
        throw new Error('wallet report RPC blocks disagree');
      }
      const age = BigInt(now()) - bs[0].timestamp;
      if (age < 0n || age > 300n) throw new Error('wallet report block is stale or future dated');
    };
    checkBlocks(blocks);
    const balances = await Promise.all(clients.map(async c => ({
      usdc: await c.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address], blockNumber }),
      native: await c.getBalance({ address, blockNumber }),
    })));
    if (balances.some(b => typeof b.usdc !== 'bigint' || b.usdc < 0n || typeof b.native !== 'bigint' || b.native < 0n) ||
        balances[0].usdc !== balances[1].usdc || balances[0].native !== balances[1].native) {
      throw new Error('wallet report RPC balances disagree');
    }
    // Both are representations of Arc's native USDC, with different precision.
    if (balances[0].native / 10n ** 12n !== balances[0].usdc) throw new Error('wallet report native and ERC20 USDC do not reconcile');
    const canonical = await Promise.all(clients.map(c => c.getBlock({ blockNumber })));
    checkBlocks(canonical);
    if (canonical[0].hash.toLowerCase() !== blocks[0].hash.toLowerCase()) throw new Error('wallet report block changed during preparation');
    const report = {
      kind: 'shadow-arc-wallet-balance-report', requestId, chainId, address, usdc: USDC,
      block: { number: blockNumber.toString(), hash: blocks[0].hash, timestamp: blocks[0].timestamp.toString(), minimumNewerBlocks: 20 },
      balance: { usdcAtomic: balances[0].usdc.toString(), usdc: formatUnits(balances[0].usdc, 6),
        nativeAtomic: balances[0].native.toString(), nativeUsdc: formatUnits(balances[0].native, 18) },
      checks: { twoRpcBlocksMatch: true, twoRpcBalancesMatch: true, canonicalBlockRechecked: true, usdcRepresentationsMatch: true },
      scope: 'Public wallet balance at the stated block. Native and ERC20 USDC represent the same asset; do not add them. This is not an assessment of total portfolio, solvency or future balance.',
    };
    return { result: `${JSON.stringify(report)}\n`, resultRef: `arc-wallet-report:${chainId}:${blockNumber}:${address}` };
  };
  return service;
}
