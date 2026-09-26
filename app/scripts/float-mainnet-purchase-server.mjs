import { parseArgs } from "node:util";
import { createPurchaseAdapter, loadPurchaseConfiguration, purchaseCatalog } from "./float-mainnet-purchase-adapter.mjs";
import { createPurchaseService } from "./float-mainnet-purchase-service.mjs";
import { initializePurchaseStore } from "./float-mainnet-purchase-store.mjs";
import { isEntrypoint } from "./float-mainnet-preflight.mjs";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: "string" }, port: { type: "string", default: "8788" } } });
  if (positionals.length !== 1 || !["init", "serve"].includes(positionals[0]) || !values.config || !/^[0-9]+$/.test(values.port) || Number(values.port) < 1024 || Number(values.port) > 65535) throw new Error("usage: purchase-server.mjs init|serve --config <private.json> [--port 8788]");
  const config = loadPurchaseConfiguration(values.config);
  if (positionals[0] === "init") {
    initializePurchaseStore(config.spec.storeDir, config.binding);
    console.log(JSON.stringify({ ok: true, status: "purchase-store-initialized" }));
    return;
  }
  const adapter = await createPurchaseAdapter(config);
  const service = createPurchaseService({ directory: config.spec.storeDir, binding: config.binding,
    token: process.env.SHADOW_PURCHASE_TOKEN, origins: config.spec.origins, catalog: purchaseCatalog(config), adapter });
  const stop = () => service.close().then(() => process.exit(0), () => process.exit(1));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  service.server.on("error", stop);
  service.server.listen(Number(values.port), "127.0.0.1", () => console.log(JSON.stringify({ ok: true, status: "listening", host: "127.0.0.1", port: Number(values.port), chainId: "5042002" })));
}
if (isEntrypoint(import.meta)) main().catch(() => { console.error("Purchase service could not start. Check private configuration and preserved stores; credentials are not printed."); process.exitCode = 1; });
