/**
 * Server entry point. Builds the Fastify app and listens. Tenant Postgres pools are closed on
 * shutdown via the app's onClose hook (registered by the pool manager).
 */
import { buildApp } from './app.js';
import { serverHost, serverPort } from './config/env.js';

async function main(): Promise<void> {
  const app = buildApp();
  await app.listen({ host: serverHost(), port: serverPort() });
  // eslint-disable-next-line no-console
  console.log(`maludb-api-server listening on http://${serverHost()}:${serverPort()}`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
