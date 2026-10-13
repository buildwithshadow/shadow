import type { Address, Hash, PublicClient, WalletClient } from 'viem';
export interface PurchaseRecord {
  stage: 'prepared' | 'accepted' | 'submitted' | 'delivered';
  requestId: string; txHash: Hash | null;
  intent: { digest: Hash; typedData: { message: { lineId: Hash; principal: string; maximumTotalDebt: string; dueAt: string; signatureExpiry: string; provider: Address; sponsor: Address; agent: Address } } };
}
export function createSelfServicePurchase(input: {
  client: PublicClient; wallet: WalletClient; storage: Storage;
  onProgress?: (message: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
  withLock?: (key: string, work: () => Promise<unknown>, operation: 'prepare' | 'submit' | 'recover' | 'archive') => Promise<unknown>;
  config: { chainId: number; account: Address; contract: Address; runtimeHash: Hash; provider: Address; providerUrl: string; endpoint: string; principal: string };
}): {
  prepare(lineId: string, requestId: string): Promise<PurchaseRecord>;
  submit(expectedDigest?: string): Promise<PurchaseRecord>;
  recover(): Promise<{ record: PurchaseRecord; status: 'blocked' | 'unconfirmed' | 'delivered'; bytes?: Uint8Array }>;
  archive(): Promise<void>;
  load(): PurchaseRecord | null;
  listArchived(): PurchaseRecord[];
  recoverArchived(digest: string): Promise<{record: PurchaseRecord; status: 'delivered'; bytes: Uint8Array}>;
  exportArchived(digest: string): Promise<string>;
  importCompleted(raw: string): Promise<{record: PurchaseRecord; status: 'delivered'; bytes: Uint8Array}>;
};

export const createGuardedMainnetPurchase: typeof createSelfServicePurchase;
