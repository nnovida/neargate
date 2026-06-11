/**
 * Loader-agnostic access to casper-js-sdk v5.
 *
 * The SDK ships as a CJS webpack bundle whose named exports are NOT statically
 * analyzable: node's cjs-module-lexer detects zero of them, so ESM named
 * imports (`import { PrivateKey } from 'casper-js-sdk'`) crash at runtime under
 * node/tsx — while bundler-based loaders (vitest/vite, Next.js) interop them
 * fine, which hides the bug from unit tests. Loading through createRequire
 * yields the real `module.exports` object under every loader.
 */
import { createRequire } from 'node:module';
import type * as Casper from 'casper-js-sdk';

const sdk = createRequire(import.meta.url)('casper-js-sdk') as typeof Casper;

export const {
  AccountHash,
  Args,
  CLValue,
  ContractCallBuilder,
  HttpHandler,
  Key,
  KeyAlgorithm,
  NativeTransferBuilder,
  ParamDictionaryIdentifier,
  ParamDictionaryIdentifierContractNamedKey,
  PrivateKey,
  PublicKey,
  RpcClient,
} = sdk;

// Re-export the instance types so the destructured consts above can also be
// used in type positions (`x: PrivateKey`, `ReturnType<NativeTransferBuilder['build']>`, …).
export type AccountHash = Casper.AccountHash;
export type Args = Casper.Args;
export type CLValue = Casper.CLValue;
export type ContractCallBuilder = Casper.ContractCallBuilder;
export type HttpHandler = Casper.HttpHandler;
export type Key = Casper.Key;
export type KeyAlgorithm = Casper.KeyAlgorithm;
export type NativeTransferBuilder = Casper.NativeTransferBuilder;
export type ParamDictionaryIdentifier = Casper.ParamDictionaryIdentifier;
export type ParamDictionaryIdentifierContractNamedKey =
  Casper.ParamDictionaryIdentifierContractNamedKey;
export type PrivateKey = Casper.PrivateKey;
export type PublicKey = Casper.PublicKey;
export type RpcClient = Casper.RpcClient;
