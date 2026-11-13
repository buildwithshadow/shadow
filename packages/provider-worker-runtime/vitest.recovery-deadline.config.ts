import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { prepare } from './test/recovery-deadline/prepare.ts';

// Config load starts an isolated non-fork anvil (chain 5042, 127.0.0.1) and deploys the actual settled contract plus MockUSDC (TEST SIMULATION).
const configPath = process.env.RD_WRANGLER ?? (process.env.RD_WRANGLER = await prepare());
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath } })],
  test: { include: ['test/recovery-deadline/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 30_000, teardownTimeout: 5_000, fileParallelism: false },
});
