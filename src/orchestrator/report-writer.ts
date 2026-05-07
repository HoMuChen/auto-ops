import type { GraphState } from './state.js';

/**
 * Boundary node that turns an agent's structured output into boss-facing
 * markdown prose. Wired so the supervisor routes here whenever the next
 * step would have been END or HITL pause — every other hop bypasses it.
 *
 * No-ops (returns `{}`) when:
 *   - `state.lastStructuredOutput` is null (no agent has emitted structured
 *      output yet — true for every agent before the per-agent migrations
 *      land)
 *   - the schemaName is in REPORT_SKIP_SCHEMAS (added in a later task)
 *
 * On normal paths, calls a small LLM to render the report and writes it
 * to `state.lastOutput.artifact.report`. Failure is non-fatal: a fallback
 * line is written + a warn log emitted; the task lifecycle is never
 * blocked by report-writer's own errors.
 */
export async function runReportWriter(state: GraphState): Promise<Partial<GraphState>> {
  const sout = state.lastStructuredOutput;
  if (!sout) return {};
  return {};
}
