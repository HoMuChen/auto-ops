import 'dotenv/config';
import { bootstrapAgents } from './agents/index.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { startNotificationDispatcher } from './notifications/dispatcher.js';
import { createServer } from './server.js';
import { TaskWorker } from './tasks/worker.js';

async function main(): Promise<void> {
  bootstrapAgents();

  const app = await createServer();
  const worker = new TaskWorker();
  const stopDispatcher = startNotificationDispatcher();

  await app.listen({ host: '0.0.0.0', port: env.PORT });
  logger.info({ port: env.PORT }, 'API listening');

  worker.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down…');
    try {
      stopDispatcher();
      await worker.stop();
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Bootstrap failed');
  process.exit(1);
});
