import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.public-testnet-test.jsonc' } })],
  test: { include: ['test/public-testnet/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 15_000, teardownTimeout: 5_000, fileParallelism: false },
});
