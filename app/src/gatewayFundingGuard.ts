import { createGatewayBrowserJournal } from "../scripts/gateway-reserve-browser-journal.mjs";
// Serialize wallet sends across current and legacy contract routes.
export function gatewayWalletLockKey(account: string): string {
  return `shadow:wallet:5042002:${account.toLowerCase()}`;
}
export function gatewayFundingPending(account: string): boolean {
  const record = createGatewayBrowserJournal({ account }).load();
  return Boolean(
    record && record.steps.mint?.evidence?.event !== "AttestationUsed",
  );
}
export function assertGatewayFundingResolved(account: string) {
  if (gatewayFundingPending(account))
    throw new Error(
      "Resolve the Gateway funding operation before starting another wallet action. Return to Funding (/start) and use its Gateway section; do not clear site data.",
    );
}
