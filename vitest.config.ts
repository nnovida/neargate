import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
