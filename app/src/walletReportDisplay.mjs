const UINT = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const USDC = '0x3600000000000000000000000000000000000000';
const CHECKS = ['twoRpcBlocksMatch','twoRpcBalancesMatch','canonicalBlockRechecked','usdcRepresentationsMatch'];
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function uint(value) {
  if (typeof value !== 'string' || value.length > 78 || !UINT.test(value)) throw Error('invalid integer');
  const number = BigInt(value);
  if (number >= 2n ** 256n) throw Error('integer overflow');
  return number;
}
function decimal(value, digits) {
  const text = value.toString().padStart(digits+1,'0');
  const fraction = text.slice(-digits).replace(/0+$/,'');
  return text.slice(0,-digits)+(fraction ? '.'+fraction : '');
}

// Presentation only. Call after the purchase engine verifies paid receipt,
// delivery signature and result hash. Unsupported data stays escaped raw text.
export function walletReportDisplay(text, expected) {
  try {
    if (typeof text !== 'string' || text.length > 1_000_000 || !expected || ![5042,5042002].includes(expected.chainId)) return null;
    const r = JSON.parse(text);
    if (r.kind !== 'shadow-arc-wallet-balance-report' || r.chainId !== expected.chainId || r.requestId !== expected.requestId
      || !ADDRESS.test(r.address ?? '') || !same(r.address,expected.account) || !same(r.usdc,USDC)
      || !HASH.test(r.block?.hash ?? '') || r.block.minimumNewerBlocks !== 20 || !CHECKS.every(key=>r.checks?.[key] === true)) return null;
    const atomic = uint(r.balance?.usdcAtomic), native = uint(r.balance?.nativeAtomic);
    if (decimal(atomic,6) !== r.balance.usdc || decimal(native,18) !== r.balance.nativeUsdc || native / 10n ** 12n !== atomic) return null;
    const number = uint(r.block.number), timestamp = uint(r.block.timestamp);
    if (timestamp > 8_640_000_000_000n) return null;
    const date = new Date(Number(timestamp) * 1000);
    if (!Number.isFinite(date.getTime())) return null;
    return { balance: decimal(atomic,6), currency: 'USDC', network: r.chainId === 5042 ? 'Arc mainnet' : 'Arc testnet',
      account:r.address, blockNumber:number.toString(), blockHash:r.block.hash, checkedAtUtc:date.toISOString(),
      checks:['Both RPC sources returned the same block','Both RPC sources returned the same balance','Block identity was rechecked','Native and token USDC representations match'],
      scope:'Signed provider report of this wallet at the stated block. Native and token USDC represent the same asset and are not added together. This is not a current portfolio or solvency assessment.' };
  } catch { return null; }
}
