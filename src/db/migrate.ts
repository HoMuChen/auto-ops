import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { db } from './client.js';

/**
 * Migration runner.
 *
 * 1. Runs Drizzle's auto-generated migrations from ./drizzle.
 * 2. Applies any hand-written *.sql files in ./drizzle that aren't in the
 *    Drizzle journal (e.g. RLS policies). These are idempotent enough for MVP;
 *    once we have many of them we'll formalize a manual_migrations journal.
 */
async function main() {
  logger.info('Running Drizzle migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });
  logger.info('Drizzle migrations complete.');

  logger.info('Applying handwritten SQL migrations…');
  const sqlClient = postgres(env.DATABASE_URL, { max: 1 });
  try {
    const dir = './drizzle';
    const files = await readdir(dir);
    const handwritten = files.filter((f) => f.startsWith('0001_') && f.endsWith('.sql')).sort();
    for (const file of handwritten) {
      const path = join(dir, file);
      const content = await readFile(path, 'utf8');
      logger.info({ file }, 'Applying SQL file');
      await sqlClient.unsafe(content);
    }
  } finally {
    await sqlClient.end();
  }
  logger.info('Migrations done.');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
