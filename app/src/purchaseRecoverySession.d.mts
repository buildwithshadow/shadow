import type { RecoveryResult } from './purchaseRecovery.mjs';
export interface RecoverySession {attempts:number; waited:number; stopped:boolean; deferred:RecoveryResult | null}
export function recoverySession(key:string): RecoverySession;
export function resetRecoverySession(key:string):void;
export function retainRecoveryTerminal(session:RecoverySession, result:RecoveryResult):void;
export function recoveryWalletBusy(key:string):boolean;
export function beginRecoveryWalletWork(key:string):void;
export function finishRecoveryWalletWork(key:string, notify?:boolean):void;
export function subscribeRecoverySettlement(listener:()=>void):()=>void;
