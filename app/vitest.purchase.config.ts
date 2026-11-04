import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { environment: 'jsdom', include: ['scripts/funding-refresh.component.test.tsx', 'scripts/public-purchase.component.test.tsx', 'scripts/service-funding-fields.component.test.tsx', 'scripts/line-lifecycle.component.test.tsx', 'scripts/purchase-workspace.component.test.tsx', 'scripts/mainnet-purchase-route.component.test.tsx'], fileParallelism: false,
    environmentOptions: { jsdom: { url: 'http://localhost/', pretendToBeVisual: true } } },
});
