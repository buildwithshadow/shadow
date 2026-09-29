import { getAddress, isHash, type Address, type Hash } from "viem";

// Explorer APIs by chain. testnet.arcscan.app redirects to this host, and only this host sends CORS headers.
const EXPLORER_API: Record<number, string> = {
  5042002: "https://explorer.testnet.arc.io/api/v2",
};
const MAX_PAGES = 10;

type ExplorerPage = {
  items?: {
    hash?: unknown;
    nonce?: unknown;
    from?: { hash?: unknown } | null;
  }[];
  next_page_params?: Record<string, unknown> | null;
};

// Finds the transaction that used a saved wallet nonce, so the recovery check can verify it.
// This only suggests a hash: reconcileCandidatePending still checks the sender, nonce, call and event on chain.
// Returns null while the nonce is unused, because an open wallet prompt could still send the saved request.
export async function findSentTransactionHash(input: {
  chainId: number;
  account: Address;
  nonce: number;
  readNextNonce: () => Promise<number>;
  fetchImpl?: typeof fetch;
}): Promise<Hash | null> {
  const api = EXPLORER_API[input.chainId];
  if (!api) return null;
  if ((await input.readNextNonce()) <= input.nonce) return null;
  const account = getAddress(input.account);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let params: Record<string, unknown> = { filter: "from" };
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    );
    const response = await fetchImpl(
      `${api}/addresses/${account}/transactions?${query}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok)
      throw new Error(
        `The explorer lookup failed with HTTP ${response.status}.`,
      );
    const data = (await response.json()) as ExplorerPage;
    const items = data.items ?? [];
    for (const item of items) {
      if (item.nonce !== input.nonce) continue;
      if (
        typeof item.hash !== "string" ||
        !isHash(item.hash) ||
        typeof item.from?.hash !== "string" ||
        getAddress(item.from.hash) !== account
      ) {
        throw new Error("The explorer returned a malformed transaction.");
      }
      return item.hash;
    }
    const oldest = items.at(-1)?.nonce;
    if (
      !data.next_page_params ||
      typeof oldest !== "number" ||
      oldest < input.nonce
    )
      return null;
    params = data.next_page_params;
  }
  return null;
}
