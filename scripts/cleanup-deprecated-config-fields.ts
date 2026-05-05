import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { agentConfigs } from '../src/db/schema/index.js';
import { logger } from '../src/lib/logger.js';

/**
 * One-shot: strip deprecated keys (brandTone, bannedPhrases,
 * preferredKeywords, targetLanguages) from agent_configs.config jsonb.
 * Safe to re-run; the `- 'key'` operator is a no-op when the key is absent.
 */
async function main() {
  const result = await db.execute(sql`
    UPDATE agent_configs
    SET config = config
      - 'brandTone'
      - 'bannedPhrases'
      - 'preferredKeywords'
      - 'targetLanguages',
        updated_at = now()
    WHERE config ?| ARRAY['brandTone','bannedPhrases','preferredKeywords','targetLanguages']
  `);
  logger.info({ rowCount: result.rowCount ?? 'unknown' }, 'cleaned deprecated config keys');
  process.exit(0);
}

main().catch((err) => {
  logger.error(err, 'cleanup failed');
  process.exit(1);
});
