// Server only. Never import this module into a browser bundle.
const SERVER = "https://mcp.blockscout.com/v1/";
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
  const call = async (tool, params) => {
    const target = new URL(tool, SERVER);
    for (const [name, value] of Object.entries(params)) target.searchParams.set(name, String(value));
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetchImpl(target, { headers: { "Blockscout-MCP-Pro-Api-Key": key, "X-Blockscout-Allow-Large-Response": "true", "User-Agent": "Blockscout-SkillGuidedScript/0.6.0" }, redirect: "error", signal });
      } catch { throw new Error("Explorer upstream unavailable"); }
      if (response.status < 500 || attempt === 2) break;
      await response.body?.cancel();
    }
    if (!response.ok) throw new Error(`Explorer upstream HTTP ${response.status}`);
    // Bound body consumption as well as network time. Never forward errors or headers.
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 3_000_000) throw new Error("Explorer response exceeds read budget");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { throw new Error("Explorer response unavailable or invalid"); }
    finally { await reader.cancel().catch(() => {}); }
  };
  const session = await call("unlock_blockchain_analysis", {});
  if (!session?.data || typeof session.data !== "object" || Array.isArray(session.data)) throw new Error("Explorer session unavailable");
  const params = { chain_id: chainId, endpoint_path: source.pathname };
  if (session.data.session_id != null) {
    if (typeof session.data.session_id !== "string" || !session.data.session_id) throw new Error("Explorer session unavailable");
    params.session_id = session.data.session_id;
  }
  for (const [name, value] of source.searchParams) {
    if (name === "mcp_cursor") {
      if (!/^[A-Za-z0-9_-]{1,8192}$/.test(value)) throw new Error("Invalid explorer continuation");
      params.cursor = value;
    } else params[`query_params[${name}]`] = value;
  }
  const result = await call("direct_api_call", params);
  if (!result?.data || typeof result.data !== "object") throw new Error("Invalid explorer data");
  const data = Array.isArray(result.data) ? { items: result.data, next_page_params: null } : { ...result.data };
  if (Array.isArray(data.items) && data.items.some(item => item?.data_truncated === true)) {
    throw new Error("Explorer log data is truncated");
  }
  if (result.pagination != null) {
    const next = result.pagination.next_call;
    if (next?.tool_name !== "direct_api_call" || String(next?.params?.chain_id) !== String(chainId)
      || next?.params?.endpoint_path !== source.pathname || !/^[A-Za-z0-9_-]{1,8192}$/.test(next?.params?.cursor ?? "")) {
      throw new Error("Invalid explorer continuation");
    }
    data.next_page_params = { mcp_cursor: next.params.cursor };
  }
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}
