import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Inline the private workspace packages so the published artifact is self-contained.
  noExternal: ['@agentgate/shared', '@agentgate/chain', '@agentgate/client'],
  // Real npm packages stay external (declared in dependencies).
  external: [
    'casper-js-sdk',
    'commander',
    '@noble/hashes',
    '@ethersproject/bignumber',
    // Official Casper x402 facilitator rail — pin the same casper-js-sdk, so
    // keep them external (never inline a second copy of the SDK).
    '@make-software/casper-x402',
    '@casper-ecosystem/casper-eip-712',
    '@x402/core',
  ],
  clean: true,
  dts: false,
  sourcemap: false,
  shims: false,
});
