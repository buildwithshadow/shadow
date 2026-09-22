export const SHADOW_ORIGIN: string;
export const SHADOW_PROVIDER_URL: string;
export function migrateShadowUrl(value: string): string;
export function resolveShadowProvider(providerUrl?: string | null, endpointLabel?: string | null): {
  url: string;
  endpointLabel: string;
};
