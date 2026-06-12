/**
 * Standalone entrypoint (Docker / Railway): boots the RWA oracle on
 * ORACLE_PORT (default 4010) with config read from the environment.
 *
 *   npx tsx packages/oracle/src/main.ts
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
