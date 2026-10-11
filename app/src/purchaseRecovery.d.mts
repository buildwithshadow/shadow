import type { PurchaseRecord } from './selfServicePurchase.mjs';
export interface RecoveryResult { record: PurchaseRecord; status: 'delivered' | 'blocked' | 'unconfirmed'; bytes?: Uint8Array }
export function recoverOriginalPurchase(options: {
  recover(): Promise<RecoveryResult>; isCurrent(): boolean;
  isBusy?: () => boolean;
  budget?: {attempts:number; waited:number; stopped?:boolean};
  onResult(result: RecoveryResult): void; onStop(error: unknown): void;
  wait?: (ms: number) => Promise<void>; now?: () => number;
}): Promise<void>;
