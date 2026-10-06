// Server only. Exact event evidence requires raw Pro API responses; the
// assistant MCP service slices and truncates log data.
const SERVER = "https://api.blockscout.com/";
const ROUTE = /^\/api\/v2\/(?:addresses\/0x[0-9a-fA-F]{40}\/(?:logs|transactions)|transactions\/0x[0-9a-fA-F]{64}(?:\/logs)?)$/;
const HOSTS = new Set(["testnet.arcscan.app", "explorer.testnet.arc.io", "explorer.arc.io"]);

export async function fetchBlockscoutExplorer(url, init = {}, { chainId, env = process.env, fetchImpl = fetch } = {}) {
  const source = new URL(url);
  if (!HOSTS.has(source.hostname) || source.protocol !== "https:" || source.username || source.password || source.port || !ROUTE.test(source.pathname)) {
    throw new Error("Unsupported explorer request");
  }
  if (![5042, 5042002].includes(Number(chainId))) throw new Error("Unsupported explorer chain");
  const expectedChain = source.hostname === "explorer.arc.io" ? 5042 : 5042002;
  if (Number(chainId) !== expectedChain) throw new Error("Explorer chain and host disagree");
  const key = env.BLOCKSCOUT_PRO_API_KEY?.trim();
  if (!key || !/^proapi_[A-Za-z0-9_-]+$/.test(key)) throw new Error("Explorer server credentials unavailable");
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  const target = new URL(`${chainId}${source.pathname}`, SERVER);
  target.search = source.search;
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetchImpl(target, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "Shadow-Explorer-Compatibility/1.0" }, redirect: "error", signal });
    } catch { throw new Error("Explorer upstream unavailable"); }
    if (response.status < 500 || attempt === 2) break;
    await response.body?.cancel();
  }
  if (!response.ok) throw new Error(`Explorer upstream HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = []; let size = 0; let data;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 3_000_000) throw new Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new Error("Explorer response unavailable or invalid"); }
  finally { await reader.cancel().catch(() => {}); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid explorer data");
  if (Array.isArray(data.items) && data.items.some(item => item?.data_truncated === true)) throw new Error("Explorer log data is truncated");
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}
