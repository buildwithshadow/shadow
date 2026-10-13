import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { environment: 'jsdom', include: ['scripts/public-purchase.component.test.tsx', 'scripts/service-funding-fields.component.test.tsx'], fileParallelism: false,
    environmentOptions: { jsdom: { url: 'http://localhost/', pretendToBeVisual: true } } },
});
