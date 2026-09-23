// Founder-run Arc testnet rehearsal adapter. The provider signs acceptance
// only after this exact reasoning packet has been fetched and durably snapshotted.
// It does not call the x402 payment endpoint: the candidate contract pays the
// provider directly, so charging through x402 as well would be a second fee.
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function createShadowReasoningService({ baseUrl = "https://www.shadowbuild.xyz", fetchImpl = fetch } = {}) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("SHADOW_REASONING_BASE_URL must be an origin without credentials or a path");
  }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) {
    throw new Error("SHADOW_REASONING_BASE_URL must use HTTPS, except on loopback");
  }

  const service = async () => {
    throw new Error("Shadow reasoning must be prepared before provider acceptance");
  };
  service.prepare = async ({ requestId }) => {
    if (!HASH.test(requestId)) return null;
    const hash = requestId.toLowerCase();
    const resource = new URL(`/api/reasoning?hash=${hash}`, base);
    const response = await fetchImpl(resource, { redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Shadow reasoning lookup failed with status ${response.status}`);
    const body = await response.json();
    const packet = body?.packet;
    if (packet === null && body?.configured === true) return null;
    if (!packet || typeof packet !== "object" || Array.isArray(packet) || packet.intentHash?.toLowerCase() !== hash ||
        !["publish", "skip"].includes(packet.decision) || typeof packet.rationale !== "string") {
      throw new Error("Shadow reasoning lookup returned a malformed or mismatched packet");
    }
    return { result: `${JSON.stringify(packet)}\n`, resultRef: resource.toString() };
  };
  return service;
}

export default createShadowReasoningService({ baseUrl: process.env.SHADOW_REASONING_BASE_URL || "https://www.shadowbuild.xyz" });
