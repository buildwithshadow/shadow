import type { GatewayRecord, GatewayStep } from "./gateway-reserve-browser-funding.mjs";
export function createGatewayBrowserJournal(options: {
  account: string;
  storage?: Storage;
  locks?: LockManager;
}): { key: string; load(): GatewayRecord | null };

export function gatewayMintConfirmed(step: GatewayStep | undefined): boolean;
