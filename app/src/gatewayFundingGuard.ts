import { createGatewayBrowserJournal, gatewayMintConfirmed } from "../scripts/gateway-reserve-browser-journal.mjs";
// Serialize wallet sends across current and legacy contract routes.
export function gatewayWalletLockKey(account: string): string {
  return `shadow:wallet:5042002:${account.toLowerCase()}`;
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
export function assertCandidateFundingResolved(account: string, storage: Storage = window.localStorage) {
  const prefix = "shadow:candidate-funding:v1:5042002:";
  const suffix = `:${account.toLowerCase()}`;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)?.toLowerCase();
    if (key?.startsWith(prefix) && key.endsWith(suffix)) {
      throw new Error("Resolve the earlier funding transaction on its original funding page before another wallet action. Keep site data.");
    }
  }
}
