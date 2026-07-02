import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Inline the private workspace packages so the published artifact is self-contained.
  noExternal: ['@agentgate/shared', '@agentgate/chain', '@agentgate/client'],
  // Real npm packages stay external (declared in dependencies).
  external: ['casper-js-sdk', 'commander', '@noble/hashes', '@ethersproject/bignumber'],
  clean: true,
  dts: false,
  sourcemap: false,
  shims: false,
});
