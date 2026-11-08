import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs test/workers/** inside workerd (via Miniflare) with the real Durable Object
// classes and SQLite storage. Nothing here talks to a live Cloudflare account.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: { include: ['test/workers/**/*.test.ts'] },
});
