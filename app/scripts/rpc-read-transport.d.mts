import type { HttpTransportConfig, Transport } from "viem";

export function createRpcReadTransport(url: string, options?: Omit<HttpTransportConfig, "retryCount"> & {
  queueOptions?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    spacingMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
    random?: () => number;
    onRetry?: (event: { label: string; attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
  };
}): Transport;
