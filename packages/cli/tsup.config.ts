import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Inline the private workspace packages so the published artifact is self-contained.
  noExternal: ['@agentgate/shared', '@agentgate/chain', '@agentgate/client'],
  // Real npm packages stay external (declared in dependencies).
  external: ['commander'],
  clean: true,
  // Types for the library entry: resolve the workspace packages through tsconfig.build.json's
  // paths and inline them, so the published types name no private package.
  tsconfig: 'tsconfig.build.json',
  dts: { entry: { index: 'src/index.ts' }, resolve: [/^@agentgate\//] },
  sourcemap: false,
  shims: false,
});
