import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "vite";

// Keep the selected Vite mode and generated route documents in one build.
const { values } = parseArgs({
  options: { mode: { type: "string", default: "production" } },
  strict: true,
  allowPositionals: false,
});
if (!values.mode) throw new Error("A nonempty Vite build mode is required");
await build({ root: fileURLToPath(new URL("./", import.meta.url)), mode: values.mode });
await import("./generate-route-pages.mjs");
