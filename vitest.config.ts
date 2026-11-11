import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The dashboard's tsconfig keeps JSX for Next to compile; its component tests need it compiled.
  esbuild: { jsx: 'automatic' },
  // `@/…` is the dashboard's import alias (dashboard/tsconfig.json paths).
  resolve: { alias: { '@': fileURLToPath(new URL('./dashboard', import.meta.url)) } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'e2e/**/*.test.ts', 'dashboard/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
