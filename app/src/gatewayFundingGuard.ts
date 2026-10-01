import { createGatewayBrowserJournal } from "../scripts/gateway-reserve-browser-journal.mjs";
export function gatewayFundingPending(account: string): boolean {
  const record = createGatewayBrowserJournal({ account }).load();
  return Boolean(
    record && record.steps.mint?.evidence?.event !== "AttestationUsed",
  );
}
export function assertGatewayFundingResolved(account: string) {
  if (gatewayFundingPending(account))
    throw new Error(
      "Resolve the Gateway funding operation before starting another wallet action. Use the Gateway section above; do not clear site data.",
    );
}
