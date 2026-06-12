/**
 * Standalone entrypoint (Docker / Railway): boots the 402 paywall gateway on
 * MIDDLEWARE_PORT (default 4021) with config read from the environment.
 *
 *   npx tsx packages/middleware/src/main.ts
 *
 * startServer() loads config itself and already installs SIGTERM/SIGINT
 * handlers that drain in-flight requests; the handlers below additionally
 * exit the process once close() resolves, so containers stop promptly.
 */
import { startServer } from './server';

const server = await startServer();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
