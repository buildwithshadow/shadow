import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = "https://mcp.blockscout.com/v1/";
const USER_AGENT = "Blockscout-SkillGuidedScript/0.6.0";

export function blockscoutKey(env = process.env) {
  const inline = env.BLOCKSCOUT_PRO_API_KEY?.trim();
  const path = env.BLOCKSCOUT_PRO_API_KEY_FILE?.trim();
  if (inline && path) throw new Error("Choose one Blockscout API key source");
  let key = inline;
  if (path) {
    if (!isAbsolute(path)) throw new Error("Blockscout key file must be an absolute path");
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error();
      key = readFileSync(path, "utf8").trim();
    } catch {
      throw new Error("Blockscout key file must be a readable private regular file");
    }
  }
  if (!key || !/^proapi_[A-Za-z0-9_-]+$/.test(key)) throw new Error("A valid Blockscout Pro API key is required");
  return key;
}

export async function blockscoutBlock({ chainId, blockNumber, env = process.env, fetchImpl = fetch }) {
  if (!["5042", "5042002"].includes(String(chainId))) throw new Error("Blockscout route is restricted to Arc");
  if (!/^\d+$/.test(String(blockNumber))) throw new Error("Block number must be an unsigned decimal integer");
  const key = blockscoutKey(env);
  const call = async (tool, params) => {
    const url = new URL(tool, SERVER);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { "Blockscout-MCP-Pro-Api-Key": key, "User-Agent": USER_AGENT },
          redirect: "error", signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new Error(`Blockscout ${tool} transport unavailable`);
      }
      if (response.status >= 500 && attempt < 2) continue;
      if (!response.ok) throw new Error(`Blockscout ${tool} HTTP ${response.status}`);
      try { return await response.json(); }
      catch { throw new Error(`Blockscout ${tool} returned invalid JSON`); }
    }
  };
  const session = await call("unlock_blockchain_analysis", {});
  const sessionId = session?.data?.session_id;
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Blockscout session initialization failed");
  const result = await call("get_block_info", { chain_id: chainId, number_or_hash: blockNumber, session_id: sessionId });
  const block = result?.data?.block_details;
  if (String(block?.height) !== String(blockNumber) || !/^0x[0-9a-fA-F]{64}$/.test(block?.hash ?? "")) {
    throw new Error("Blockscout returned a malformed or different block");
  }
  return { height: String(block.height), hash: block.hash.toLowerCase(), timestamp: block.timestamp };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [chainId, blockNumber] = process.argv.slice(2);
  blockscoutBlock({ chainId, blockNumber }).then(block => {
    console.log(JSON.stringify({ route: "blockscout-mcp", chainId, block }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
