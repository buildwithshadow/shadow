export const SHADOW_ORIGIN = "https://www.shadowbuild.xyz";
export const SHADOW_PROVIDER_URL = `${SHADOW_ORIGIN}/api/reasoning-x402`;

// This historical label is hashed into existing mandates; it is never fetched.
const LEGACY_PROVIDER_LABEL = "https://shadow-arc.vercel.app/api/reasoning-x402";
const LEGACY_HOSTS = new Set(["shadow-arc.vercel.app", "shadow-two-opal.vercel.app"]);

export function migrateShadowUrl(value) {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && LEGACY_HOSTS.has(url.hostname)) {
      url.protocol = "https:";
      url.hostname = "www.shadowbuild.xyz";
      url.port = "";
      return url.href;
    }
  } catch {
    // Preserve existing validation behavior for malformed caller overrides.
  }
  return value;
}

export function resolveShadowProvider(providerUrl, endpointLabel) {
  const sourceUrl = providerUrl || SHADOW_PROVIDER_URL;
  return {
    url: migrateShadowUrl(sourceUrl),
    endpointLabel: endpointLabel || providerUrl || LEGACY_PROVIDER_LABEL,
  };
}
