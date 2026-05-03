/**
 * Task artifacts — the typed deliverable produced by every agent.
 *
 *   {
 *     report: string,             // markdown narrative — primary surface
 *     body?: string,              // markdown deliverable — only for content agents
 *     refs?: Record<string, unknown>,  // structured contract for IDs/URLs/scheduling
 *   }
 *
 * Inter-agent handoff is markdown; structured fields exist only where they
 * absolutely must (machine reading by tools, spawn routing, idempotency stamps).
 *
 * See docs/plans/2026-05-04-markdown-first-artifacts-design.md for rationale.
 */
export interface Artifact {
  /** Canonical narrative (markdown). Audience: humans + downstream agents. */
  report: string;
  /** Deliverable content (markdown). Only present when an agent produces
   *  publishable content (article body, product description). Converted to
   *  HTML at the publish boundary via `markdownToHtml`. */
  body?: string;
  /** Structured contract: IDs, URLs, scheduling, routing, publish stamps.
   *  Free-form bag — keys agreed between producing agent and any consumer
   *  (publisher, tool-executor). Frontend ignores it apart from a small
   *  details panel. */
  refs?: Record<string, unknown>;
}
