import { type TenantProfile, getTenantProfile } from '../tenants/profile-repository.js';

/**
 * Per-task runtime context block prepended to every system prompt
 * (supervisor + each agent) by the orchestrator. Single insertion point
 * for tenant- or time-sensitive facts the LLM needs but the static prompt
 * template doesn't carry.
 *
 * Throws NotFoundError if the tenant row is gone — at this point in the
 * request lifecycle the tenant must exist (requireTenant already gated;
 * agentRegistry.listForTenant has already read the same row). A miss here
 * is an invariant violation, not a defensive case.
 *
 * The graph is rebuilt fresh for every worker pickup (runner.ts → buildGraph),
 * so resumed tasks always see "now" and pick up tenant profile edits made
 * between attempts.
 */
export async function buildRuntimeContext(tenantId: string): Promise<string> {
  return formatRuntimeContext(await getTenantProfile(tenantId));
}

/**
 * Pure formatter — call this when the profile has already been resolved
 * (e.g. `buildGraph` resolves it once and feeds the same row into
 * `ctx.systemPrompt` and `ctx.tenantProfile`, so agents don't re-fetch).
 */
export function formatRuntimeContext(profile: TenantProfile): string {
  const now = new Date().toISOString();
  const trimmed = profile.profileMd?.trim();

  let block = `Runtime context:\n- Current time: ${now}\n- Tenant timezone: ${profile.timezone}\n`;
  if (trimmed) {
    block += `\n## Tenant profile\n\n${trimmed}\n`;
  }
  return `${block}\n---\n\n`;
}
