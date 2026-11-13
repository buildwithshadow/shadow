import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs test/**/*.test.ts inside local workerd (Miniflare) against the pinned provider source. Every test is
// bounded by a real timeout; a hung test fails by name instead of hanging the run. Nothing leaves the machine.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: { include: ['test/**/*.test.ts'], exclude: ['**/node_modules/**', 'test/public-testnet/**', 'test/recovery-deadline/**'], testTimeout: 15_000, hookTimeout: 15_000, teardownTimeout: 5_000 },
});
