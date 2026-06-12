/**
 * Standalone entrypoint (Docker only — devnet is the MOCK chain, never hosted
 * in live mode): boots the devnet on DEVNET_PORT (default 4030).
 *
 *   npx tsx packages/devnet/src/main.ts
 */
import { startServer } from './index';

const server = await startServer();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
