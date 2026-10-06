import { createGatewayBrowserJournal, gatewayMintConfirmed } from "../scripts/gateway-reserve-browser-journal.mjs";
// Serialize wallet sends across current and legacy contract routes.
export function gatewayWalletLockKey(account: string, chainId = 5042002): string {
  return `shadow:wallet:${chainId}:${account.toLowerCase()}`;
}
export function gatewayFundingPending(account: string): boolean {
  const record = createGatewayBrowserJournal({ account }).load();
  return Boolean(
    record && !gatewayMintConfirmed(record.steps.mint),
  );
}
export function assertGatewayFundingResolved(account: string) {
  if (gatewayFundingPending(account))
    throw new Error(
      "Resolve the Gateway funding operation before starting another wallet action. Return to Funding (/start) and use its Gateway section; do not clear site data.",
    );
}

// Any saved candidate transaction remains pending until its owning route has
// reconciled and cleared it. Include legacy deployments, and fail closed even
// for unreadable records rather than guessing whether a nonce is available.
export function assertCandidateFundingResolved(account: string, storage: Storage = window.localStorage, chainId = 5042002) {
  const prefix = `shadow:candidate-funding:v1:${chainId}:`;
  const suffix = `:${account.toLowerCase()}`;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)?.toLowerCase();
    if (key?.startsWith(prefix) && key.endsWith(suffix)) {
      throw new Error("Resolve the earlier funding transaction on its original funding page before another wallet action. Keep site data.");
    }
  }
}

// An unresolved purchase on any deployment of this chain must not be hidden by
// switching routes. Reading and recovering it still remain available.
export function assertPurchaseResolved(account: string, storage: Storage = window.localStorage, chainId = 5042002, ownRecordKey?: string) {
  const prefix = `shadow.public-purchase.v1:${chainId}:`;
  const suffix = `:${account.toLowerCase()}`;
  for (let i = 0; i < storage.length; i++) {
    const originalKey = storage.key(i);
    const key = originalKey?.toLowerCase();
    if (originalKey && key?.startsWith(prefix) && key.endsWith(suffix) && key !== ownRecordKey?.toLowerCase()) {
      let record;
      try { record = JSON.parse(storage.getItem(originalKey) ?? 'null'); } catch { /* preserve the hold */ }
      if (record?.stage !== 'delivered') throw new Error('Resolve the earlier purchase on its original page before another wallet action. Recovery remains available; keep site data.');
    }
  }
}
