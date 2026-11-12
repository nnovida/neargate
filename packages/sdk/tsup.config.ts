import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Inline the private workspace packages, code and types, so the published package stands alone.
  noExternal: ['@agentgate/shared', '@agentgate/chain', '@agentgate/client'],
  // Types: resolve the workspace packages through tsconfig.build.json's paths and inline them.
  tsconfig: 'tsconfig.build.json',
  dts: { resolve: [/^@agentgate\//] },
  clean: true,
  sourcemap: false,
  shims: false,
});
