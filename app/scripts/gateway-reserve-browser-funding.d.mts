export interface GatewayPlan {
  intent: {
    maxFee: string;
    maxBlockHeight: string;
    spec: { value: string; [key: string]: unknown };
  };
  operation: string;
}
export interface GatewayStep {
  request?: { nonce?: string };
  status: "unknown" | "confirmed";
  response?: { hash?: `0x${string}`; notSubmitted?: boolean };
  evidence?: { hash?: `0x${string}`; notSubmitted?: boolean; event?: string; blockHash?: `0x${string}`; blockNumber?: string };
}
export interface GatewayRecord extends GatewayPlan {
  steps: Record<string, GatewayStep>;
}
export interface GatewayFunding {
  archive(): Promise<void>;
  load(): GatewayRecord | null;
  quote(amount: string): Promise<GatewayPlan>;
  authorize(plan: GatewayPlan): Promise<GatewayStep>;
  mint(): Promise<GatewayStep>;
  recover(hash?: string): Promise<GatewayStep>;
}
export function createGatewayBrowserFunding(options: {
  account: string;
  wallet: unknown;
  clients: unknown[];
  journal: unknown;
}): GatewayFunding;
