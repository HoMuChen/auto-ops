/**
 * Runtime context — a small block prepended to every LLM system prompt
 * (supervisor + each agent) by the orchestrator. This is the single insertion
 * point for tenant- or time-sensitive facts the LLM needs but the static
 * prompt template doesn't carry.
 *
 * Today this only carries the current ISO timestamp, which lets agents reason
 * about scheduling, deadlines, seasonal SEO, "this week" type asks, etc. The
 * graph is rebuilt fresh for every worker pickup (see runner.ts → buildGraph),
 * so resumed tasks always see "now", not the time when they first started.
 *
 * Future extensions belong here, not in individual agent code:
 *   - Tenant industry / vertical (e.g. "fashion ecommerce", "B2B SaaS")
 *   - Tenant brand voice / tone preferences
 *   - Tenant banned phrases / compliance constraints
 *   - Tenant timezone (so "every 3 days" and "next Monday" resolve correctly)
 *   - Task attempt count (let agents soften / change tactic on retry)
 *
 * When tenant-keyed context lands, this signature will take `tenantId` and
 * return Promise<string>. Both call sites are already async, so the change
 * is mechanical.
 */
export function buildRuntimeContext(): string {
  const now = new Date().toISOString();
  return `Runtime context:
- Current time: ${now}

---

`;
}
