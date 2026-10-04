import assert from "node:assert/strict";
import test from "node:test";
import { findSentTransactionHash } from "../src/savedTransactionLookup.ts";

const ACCOUNT = "0x894f6d4d3a7cFF40aeFD63Ac3794358E38a3dDc3";
const OTHER = "0x1DeD16AF6d2868e04F52fe65C8d2B417872119e2";
const hashFor = (nonce: number) => `0x${nonce.toString(16).padStart(64, "0")}`;
const item = (nonce: number, from = ACCOUNT) => ({
  nonce,
  hash: hashFor(nonce),
  from: { hash: from },
});

function explorer(
  pages: {
    items: unknown[];
    next_page_params: Record<string, unknown> | null;
  }[],
) {
  const urls: string[] = [];
  const signals: unknown[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    signals.push(init?.signal);
    const page = pages[urls.length - 1];
    if (!page) throw new Error("unexpected extra request");
    return { ok: true, status: 200, json: async () => page };
  }) as unknown as typeof fetch;
  return { urls, signals, fetchImpl };
}

const base = (nonce: number, nextNonce: number, fetchImpl: typeof fetch) =>
  ({
    chainId: 5042002,
    account: ACCOUNT,
    nonce,
    readNextNonce: async () => nextNonce,
    fetchImpl,
  }) as const;

test("an unused nonce is never looked up, because an open wallet prompt could still send it", async () => {
  const { urls, fetchImpl } = explorer([]);
  assert.equal(await findSentTransactionHash(base(17, 17, fetchImpl)), null);
  assert.equal(await findSentTransactionHash(base(17, 12, fetchImpl)), null);
  assert.equal(urls.length, 0);
});

test("a used nonce returns the transaction from the saved account", async () => {
  const { urls, signals, fetchImpl } = explorer([
    {
      items: [item(20), item(19), item(18), item(17), item(16)],
      next_page_params: null,
    },
  ]);
  assert.equal(
    await findSentTransactionHash(base(17, 21, fetchImpl)),
    hashFor(17),
  );
  assert.equal(urls.length, 1);
  assert.ok(signals[0] instanceof AbortSignal, "each explorer request carries a timeout signal");
  assert.match(
    urls[0],
    /^https:\/\/explorer\.testnet\.arc\.io\/api\/v2\/addresses\/0x894f6d4d3a7cFF40aeFD63Ac3794358E38a3dDc3\/transactions\?filter=from$/,
  );
});

test("older nonces are found by following the explorer's page parameters", async () => {
  const next = {
    block_number: 64389445,
    index: 17,
    items_count: 50,
  };
  const { urls, fetchImpl } = explorer([
    { items: [item(70), item(60), item(51)], next_page_params: next },
    { items: [item(40), item(30), item(20)], next_page_params: null },
  ]);
  assert.equal(
    await findSentTransactionHash(base(30, 71, fetchImpl)),
    hashFor(30),
  );
  assert.equal(urls.length, 2);
  const query = new URL(urls[1]).searchParams;
  assert.equal(query.get("filter"), "from");
  assert.equal(query.get("block_number"), "64389445");
  assert.equal(query.get("index"), "17");
  assert.equal(query.get("items_count"), "50");
});

test("the search stops once pages are older than the saved nonce", async () => {
  const { urls, fetchImpl } = explorer([
    {
      items: [item(20), item(18)],
      next_page_params: { block_number: 1, index: 0 },
    },
  ]);
  assert.equal(await findSentTransactionHash(base(19, 21, fetchImpl)), null);
  assert.equal(urls.length, 1);
});

test("the search is bounded to ten pages", async () => {
  const pages = Array.from({ length: 10 }, (_, page) => ({
    items: [item(1000 - page)],
    next_page_params: { block_number: 1000 - page, index: 0 },
  }));
  const { urls, fetchImpl } = explorer(pages);
  assert.equal(await findSentTransactionHash(base(5, 1001, fetchImpl)), null);
  assert.equal(urls.length, 10);
});

test("a chain without a known explorer is not looked up", async () => {
  const { urls, fetchImpl } = explorer([]);
  assert.equal(
    await findSentTransactionHash({
      ...base(17, 21, fetchImpl),
      chainId: 123456,
    }),
    null,
  );
  assert.equal(urls.length, 0);
});

test("explorer failures and malformed results throw instead of guessing", async () => {
  const failing = (async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  await assert.rejects(
    findSentTransactionHash(base(17, 21, failing)),
    /HTTP 503/,
  );
  const wrongSender = explorer([
    { items: [item(17, OTHER)], next_page_params: null },
  ]);
  await assert.rejects(
    findSentTransactionHash(base(17, 21, wrongSender.fetchImpl)),
    /malformed/,
  );
  const badHash = explorer([
    {
      items: [{ nonce: 17, hash: "0x1234", from: { hash: ACCOUNT } }],
      next_page_params: null,
    },
  ]);
  await assert.rejects(
    findSentTransactionHash(base(17, 21, badHash.fetchImpl)),
    /malformed/,
  );
});


test('mainnet nonce lookup uses its own explorer and never the testnet host',async()=>{
  const x=explorer([{items:[item(17)],next_page_params:null}]);
  assert.equal(await findSentTransactionHash({...base(17,21,x.fetchImpl),chainId:5042}),hashFor(17));
  assert(x.urls[0].startsWith('https://explorer.arc.io/api/v2/'));
});
