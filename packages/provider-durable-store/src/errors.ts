// Errors cross Durable Object RPC as plain Error values, so the kind travels in a
// message marker and is rebuilt by `rehydrate`. Never rely on custom properties.

export type StoreErrorKind = 'hold' | 'busy' | 'invalid' | 'full';

const MARKER = /^\[provider-store:(hold|busy|invalid|full)\] ?/;

export class ProviderStoreError extends Error {
  readonly kind: StoreErrorKind;
  readonly status: number;
  readonly detail: string;
  constructor(kind: StoreErrorKind, status: number, detail: string) {
    super(`[provider-store:${kind}] ${detail}`);
    this.name = 'ProviderStoreError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/** The store is inconsistent or unsafe. It stays held until explicit reconciliation. */
export class ProviderStoreHold extends ProviderStoreError {
  constructor(detail: string) { super('hold', 409, `Provider store needs reconciliation: ${detail}`); }
}
/** A retryable condition (publication in flight). Never means healthy. */
export class ProviderStoreBusy extends ProviderStoreError {
  constructor(detail: string) { super('busy', 503, detail); }
}
/** The caller sent something malformed. Nothing was written. */
export class ProviderStoreInvalid extends ProviderStoreError {
  constructor(detail: string) { super('invalid', 400, detail); }
}
/** A configured bound was reached. Nothing was written. */
export class ProviderStoreFull extends ProviderStoreError {
  constructor(detail: string) { super('full', 507, detail); }
}

export function rehydrate(error: unknown): Error {
  if (error instanceof ProviderStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const match = MARKER.exec(message);
  if (!match) return error instanceof Error ? error : new Error(message);
  const detail = message.slice(match[0].length);
  switch (match[1]) {
    case 'hold': return new ProviderStoreHold(detail.replace(/^Provider store needs reconciliation: /, ''));
    case 'busy': return new ProviderStoreBusy(detail);
    case 'invalid': return new ProviderStoreInvalid(detail);
    default: return new ProviderStoreFull(detail);
  }
}
