export type WalletRequester = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
export type WalletChainParameters = { chainId: string; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] };

// Wallet extensions can reject with plain objects and nested JSON RPC errors.
// Read only bounded error metadata; never echo response bodies or credentials.
export function walletErrorCode(error: unknown): number | null {
  const queue: unknown[] = [error], seen = new Set<unknown>();
  let fallback: number | null = null;
  for (let count = 0; queue.length && count < 16; count++) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const item = value as Record<string, unknown>;
    const code = typeof item.code === 'number' ? item.code : typeof item.code === 'string' && /^-?\d+$/.test(item.code) ? Number(item.code) : NaN;
    if (Number.isSafeInteger(code)) {
      if ([4001, 4100, 4200, 4900, 4901, 4902, -32002, -32601].includes(code)) return code;
      fallback ??= code;
    }
    for (const nested of [item.cause, item.error, item.data, item.originalError]) {
      if (nested && typeof nested === 'object') queue.push(nested);
    }
  }
  return fallback;
}

export function walletRequestHelp(error: unknown): string | null {
  const code = walletErrorCode(error);
  if (code === 4001) return 'The wallet request was declined. Check your wallet activity before trying again.';
  if (code === -32002) return 'A request is already waiting in your wallet. Open the wallet extension and complete or cancel that request first.';
  if (code === 4100) return 'Your wallet has not authorized this connection. Unlock it, connect this site, then select Refresh wallet.';
  if (code === 4200 || code === -32601) return 'Your wallet does not support this request. Select the required network inside the wallet, then select Refresh wallet.';
  if (code === 4900 || code === 4901) return 'Your wallet is disconnected from the required network. Open its network settings, check the RPC connection, then select Refresh wallet.';
  if (code === 4902) return 'The required network has not been added to your wallet. Add the required network in your wallet settings, then select Refresh wallet.';
  if (code !== null) return `The wallet could not complete this request (code ${code}). Open the wallet for details. Check any pending transaction before trying again.`;
  return null;
}

export async function ensureWalletChain(provider: WalletRequester, chain: WalletChainParameters): Promise<number> {
  const expected = Number(chain.chainId);
  if (!/^0x[0-9a-f]+$/i.test(chain.chainId) || !Number.isSafeInteger(expected) || expected <= 0) throw new Error('Invalid target network.');
  const readChain = async () => {
    const current = await provider.request({ method: 'eth_chainId' });
    if (typeof current !== 'string' || !/^0x[0-9a-f]+$/i.test(current)) throw new Error('Your wallet did not report its current network. Open it and select Refresh wallet.');
    return Number(current);
  };
  if (await readChain() === expected) return expected;
  const switchChain = () => provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainId }] });
  try { await switchChain(); }
  catch (cause) {
    if (walletErrorCode(cause) !== 4902) throw cause;
    await provider.request({ method: 'wallet_addEthereumChain', params: [chain] });
    // EIP 3085 does not guarantee that adding a chain selects it.
    if (await readChain() !== expected) await switchChain();
  }
  if (await readChain() !== expected) throw new Error(`Your wallet is still on another network. Select ${chain.chainName} inside the wallet, then select Refresh wallet.`);
  return expected;
}
