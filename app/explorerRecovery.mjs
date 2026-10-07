import { getAddress, isAddress, isHash } from "viem";
import { fetchBlockscoutExplorer } from "./blockscoutExplorer.mjs";

const cache = new Map();
let windowAt = 0;
let requests = 0;
const CURSOR_NAMES = ["block_number", "index", "items_count", "value", "hash", "inserted_at", "fee"];
function validCursorField(name, value) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const text = String(value);
  if (["value", "fee"].includes(name)) return /^\d{1,78}$/.test(text) && BigInt(text) < 2n ** 256n;
  if (name === "hash") return isHash(text);
  if (name === "inserted_at") return text.length <= 40 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(text) && Number.isFinite(Date.parse(text));
  return ["block_number", "index", "items_count"].includes(name) && /^\d{1,16}$/.test(text);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });
  const query = req.query ?? {};
  const chainId = Number(query.chainId);
  const account = query.account;
  const cursorNames = CURSOR_NAMES;
  if (![5042, 5042002].includes(chainId) || typeof account !== "string" || !isAddress(account)
    || Object.keys(query).some(name => !["chainId", "account", "filter", ...cursorNames].includes(name))
    || (query.filter !== undefined && query.filter !== "from")
    || cursorNames.some(name => query[name] !== undefined && !validCursorField(name, query[name]))) {
    return res.status(400).json({ error: "Invalid explorer lookup" });
  }
  const host = chainId === 5042 ? "explorer.arc.io" : "explorer.testnet.arc.io";
  const url = new URL(`https://${host}/api/v2/addresses/${getAddress(account)}/transactions`);
  url.searchParams.set("filter", "from");
  for (const name of cursorNames) if (query[name] !== undefined) url.searchParams.set(name, query[name]);
  const cached = cache.get(url.href);
  if (cached && Date.now() - cached.at < 10_000) return res.status(200).json(cached.data);
  if (Date.now() - windowAt >= 60_000) { windowAt = Date.now(); requests = 0; }
  if (++requests > 60) return res.status(429).json({ error: "Explorer lookup rate limited" });
  try {
    const response = await fetchBlockscoutExplorer(url.href, undefined, { chainId });
    const data = await response.json();
    if (!Array.isArray(data.items) || data.items.length > 100 || data.items.some((item) =>
      !isHash(item?.hash ?? "") || !Number.isSafeInteger(item?.nonce) || item.nonce < 0
      || !isAddress(item?.from?.hash ?? "") || getAddress(item.from.hash) !== getAddress(account))) throw new Error();
    const next = data.next_page_params;
    if (next != null && (typeof next !== "object" || Array.isArray(next)
      || Object.entries(next).some(([name, value]) => !cursorNames.includes(name) || !validCursorField(name, value)))) throw new Error();
    const result = {
      items: data.items.map((item) => ({ hash: item.hash, nonce: item.nonce, from: { hash: item.from?.hash } })),
      next_page_params: data.next_page_params ?? null,
    };
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(url.href, { at: Date.now(), data: result });
    return res.status(200).json(result);
  } catch {
    return res.status(503).json({ error: "Explorer lookup unavailable; keep the original operation pending" });
  }
}
