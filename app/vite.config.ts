import react from "@vitejs/plugin-react";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

function gatedMainnetMetadata(): Plugin {
  const metadataPath = fileURLToPath(new URL("./routeMetadata.json", import.meta.url));
  let enabled = false;
  let guardedTestnet = false;
  let building = false;
  let outputDirectory = "";
  return {
    name: "shadow-gated-mainnet-metadata",
    enforce: "pre",
    configResolved(config) {
      enabled = config.env.VITE_SHADOW_GUARDED_MAINNET_CANDIDATE === "true";
      guardedTestnet = config.env.VITE_SHADOW_GUARDED_TESTNET_CANDIDATE === "true";
      building = config.command === "build";
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    transform(source, id) {
      if (enabled || id.split("?")[0] !== metadataPath) return;
      const metadata = JSON.parse(source);
      for (const name of ["routeTitles", "socialDescriptions", "socialImages"]) delete metadata[name]["/mainnet"];
      return { code: JSON.stringify(metadata), map: null };
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: ".shadow-route-flags.json",
        source: JSON.stringify({ schemaVersion: 1, mainnet: enabled, guardedTestnet }),
      });
    },
    async closeBundle() {
      if (!building || enabled) return;
      await Promise.all(["og-shadow-mainnet.png", "og-shadow-mainnet.svg"].map(name =>
        rm(resolve(outputDirectory, name), { force: true })));
    },
  };
}

export default defineConfig({
  plugins: [gatedMainnetMetadata(), react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@circle-fin")) return "circle";
          if (id.includes("viem")) return "viem";
        },
      },
    },
  },
});
