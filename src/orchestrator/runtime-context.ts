import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenants } from '../db/schema/index.js';

/**
 * Per-task runtime context block prepended to every system prompt
 * (supervisor + each agent) by the orchestrator. Single insertion point
 * for tenant- or time-sensitive facts the LLM needs but the static prompt
 * template doesn't carry.
 *
 * The graph is rebuilt fresh for every worker pickup (runner.ts → buildGraph),
 * so resumed tasks always see "now", not the time when they first started,
 * and pick up tenant profile edits made between attempts.
 */
export async function buildRuntimeContext(tenantId: string): Promise<string> {
  const [row] = await db
    .select({ profileMd: tenants.profileMd, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const now = new Date().toISOString();
  const tz = row?.timezone ?? 'UTC';
  const profile = row?.profileMd?.trim();

  let block = `Runtime context:\n- Current time: ${now}\n- Tenant timezone: ${tz}\n`;
  if (profile) {
    block += `\n## Tenant profile\n\n${profile}\n`;
  }
  return `${block}\n---\n\n`;
}
