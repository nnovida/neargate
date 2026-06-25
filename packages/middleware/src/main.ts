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
import { createLogger } from '@agentgate/shared';
import { startServer, type RunningServer } from './server';

const logger = createLogger('middleware');
let server: RunningServer | undefined;

// Last-resort safety net: log (never crash silently) and exit non-zero so the
// orchestrator restarts a process left in an undefined state.
process.on('unhandledRejection', (reason: unknown) => {
  logger.error('unhandled_rejection', {
    error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
  });
});
process.on('uncaughtException', (err: Error) => {
  logger.error('uncaught_exception', { error: `${err.name}: ${err.message}` });
  const done = (): never => process.exit(1);
  if (server) server.close().then(done, done);
  else done();
});

server = await startServer();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server?.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
