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
    // Pick up everything ending in `.sql` that's NOT a Drizzle-generated file.
    // Drizzle generates `<idx>_<name>.sql` plus a `meta/` dir; handwritten files
    // live alongside them and follow the same numeric prefix convention.
    // Files renamed `*.sql.disabled` are intentionally skipped (see the file's
    // header for the rationale and how to re-enable).
    const drizzleJournal = await readFile(join(dir, 'meta/_journal.json'), 'utf8');
    const journal = JSON.parse(drizzleJournal) as { entries?: { tag: string }[] };
    const generatedSet = new Set((journal.entries ?? []).map((e) => `${e.tag}.sql`));
    const handwritten = files.filter((f) => f.endsWith('.sql') && !generatedSet.has(f)).sort();
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
