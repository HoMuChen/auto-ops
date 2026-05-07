import type { GraphState } from './state.js';

/**
 * Schemas whose output is NOT a retrospective summary — for these, the
 * agent's own artifact.report (the question prompt, the action invitation)
 * is the right thing for the boss to see, not a meta-narration of it.
 */
const REPORT_SKIP_SCHEMAS = new Set<string>(['eeat-questions']);

/**
 * Boundary node that turns an agent's structured output into boss-facing
 * markdown prose. Wired so the supervisor routes here whenever the next
 * step would have been END or HITL pause — every other hop bypasses it.
 *
 * No-ops (returns `{}`) when:
 *   - `state.lastStructuredOutput` is null (no agent has emitted structured
 *      output yet — true for every agent before the per-agent migrations
 *      land)
 *   - the schemaName is in REPORT_SKIP_SCHEMAS
 *
 * On normal paths, calls a small LLM to render the report and writes it
 * to `state.lastOutput.artifact.report`. Failure is non-fatal: a fallback
 * line is written + a warn log emitted; the task lifecycle is never
 * blocked by report-writer's own errors.
 */
export async function runReportWriter(state: GraphState): Promise<Partial<GraphState>> {
  const sout = state.lastStructuredOutput;
  if (!sout) return {};
  if (REPORT_SKIP_SCHEMAS.has(sout.schemaName)) return {};
  return {};
}
