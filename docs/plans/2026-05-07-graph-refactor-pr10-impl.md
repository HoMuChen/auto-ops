# Graph Refactor PR10: Cleanup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Strip migration-era language from comments now that PR3-7 are landed. Pure comment hygiene — zero behavior change, zero test changes, zero new tests.

**Architecture:** Find every "Post-PR7:" / "(PR5)" / "before per-agent migrations land" / "agents that haven't migrated yet" / "PR1 wired the channel" reference and either delete it or tighten it to describe present-tense reality. CLAUDE.md says: *"Don't reference the current task, fix, or callers ('used by X', 'added for the Y flow', 'handles the case from issue #123'), since those belong in the PR description and rot as the codebase evolves."* That's exactly what this PR removes.

**What this PR does NOT do (intentionally):**
- **Drop the `result.structuredOutput ? {} : {}` conditional spread in `graph.ts`.** Every registered agent currently emits `structuredOutput`, but the type is still optional and supervisor returns its own `Partial<GraphState>` without going through the agent-node loop. The conditional is type-system-required and costs ~3 lines — keep it. The matching conditional in `runner.ts:187` IS load-bearing (supervisor clarification path leaves `lastStructuredOutput` null). Don't touch either.
- **Make `structuredOutput` required on `AgentOutput`.** Bigger contract change with no observable benefit — the optional field correctly models supervisor / hypothetical plain-text agents. YAGNI.
- **Rewrite supervisor prompt.** Re-read confirms it's already migration-neutral (no PR-era references). The design doc said "tidy supervisor prompt" but there's nothing stale to tidy. Skip.
- **Touch the deprecated `Artifact.report?` field.** It's still used by eeat-interviewer (which writes the question prompt directly) and supervisor (clarification path). Both are intentional. Field stays optional.
- **Remove `REPORT_SKIP_SCHEMAS`.** The `eeat-questions` entry is still load-bearing — it's the mechanism that lets eeat-interviewer's hand-written `artifact.report` survive the report-writer node intact.

**Tech Stack:** Just text edits — no compilation or runtime change. The full test suite must still pass identically.

**Design ref:** `docs/plans/2026-05-07-graph-refactor-design.md` §"PR10 — Cleanup" (says "Remove deprecated `artifact.report`-from-agent codepath; Remove any backwards-compat shims; Tidy supervisor prompt"). The "deprecated codepath" framing turned out to be inaccurate after surveying the code: the no-op guards in report-writer and runner are not deprecated, they're load-bearing for the supervisor clarification path. So the actual scope shrank to comment hygiene, with the rationale documented above.

---

## Pre-flight

```bash
pnpm typecheck             # expect: clean
pnpm lint                  # expect: clean
pnpm test                  # expect: 210 passed (PR7 baseline)
pnpm test:integration      # expect: 104 passed
```

If baseline isn't green, stop — PR10 lands on a clean main or not at all.

**Worktree setup:** Use `superpowers:using-git-worktrees` to create `.worktrees/graph-refactor-pr10` on branch `feat/graph-refactor-pr10`. Copy `.env`: `cp /Users/largitdata/project/auto-ops/.env .env`.

**Scope sanity check (run from the worktree):**

```bash
grep -rn "PR[0-9]\|pre-PR\|post-PR\|Post-PR\|mid-migration\|haven't migrated\|before this refactor\|before the per-agent\|before the report-writer refactor" src/ tests/ --include="*.ts"
```

Expected matches (anything else surfaces, add it to the relevant Task or stop and re-scope). All references should be in this list (10 source files, 7 test files):

**Source (10 sites):**
- `src/tasks/artifact.ts:18` — "Optional from PR2 onwards"
- `src/agents/types.ts:234-235` — "agents added before the report-writer refactor"
- `src/agents/builtin/article-writer/index.ts:291-293` — "PR1 wired the channel; this is the first agent that uses it in production."
- `src/agents/builtin/shopify-publisher/index.ts:78` — "(PR7 plan §"Architecture")"
- `src/agents/builtin/shopify-publisher/content.ts:6` — "Post-PR7: the boss-facing prose..."
- `src/agents/builtin/product-designer/index.ts:234-236` — "Image markdown moves from `report` (PR5) to `body` (PR6)..."
- `src/orchestrator/state.ts:85` — "before this refactor lands per-agent"
- `src/orchestrator/report-writer.ts:51-53` — "every agent before the per-agent migrations land"
- `src/orchestrator/graph.ts:129-131` — "Agents that don't emit structuredOutput leave the channel as-is"
- `src/tasks/runner.ts:185-186` — "for agents that haven't migrated yet"

**Tests (7 sites — strip "Post-PRn:" / "(post-PRn)" tags only; do NOT change assertions):**
- `tests/market-researcher.test.ts:4` — "(post-PR3)"
- `tests/shopify-publisher.test.ts:5,9,16,90` — "(post-PR7)" / "Post-PR7 contract" / "Post-PR7:"
- `tests/product-designer.test.ts:5,9,150,202` — "(post-PR7)" / "Post-PR7 contract" / "Post-PR7:"
- `tests/product-planner.test.ts:4` — "(post-PR4)"
- `tests/integration/product-publisher.test.ts:158,219,274` — "Post-PR4:" / "Post-PR6:" / "Post-PR7:"
- `tests/integration/spawning.test.ts:129` — "Post-PR5:"
- `tests/integration/seo-cluster.test.ts:168` — "Post-PR5:"

If your grep finds **only** these matches → proceed. If you find extras → add them to the relevant Task and report what you added.

> **Note on `src/db/migrate.ts` etc.:** The grep for `migration` legitimately matches drizzle migrations / DB schema comments — those are NOT in scope. The grep above narrows to PR-era language specifically.

---

## Phase A — Source comment hygiene (10 edits, single commit)

Apply each edit precisely with the `Edit` tool. The `old_string` blocks are quoted verbatim from the current code; the `new_string` blocks are the replacements. After all 10 edits, `pnpm typecheck` should still pass — these are comment-only changes.

### Task 1: `src/tasks/artifact.ts`

**Find:**

```ts
  /**
   * Canonical narrative (markdown). Audience: humans + downstream agents.
   * Optional from PR2 onwards: agents may emit `structuredOutput` instead
   * and leave this for the report-writer node to fill in.
   */
  report?: string;
```

**Replace with:**

```ts
  /**
   * Canonical narrative (markdown). Audience: humans + downstream agents.
   * Usually filled by the report-writer node from the agent's
   * `structuredOutput`; agents may also write it directly when they ARE the
   * boss-facing prose (eeat-interviewer's question prompt, supervisor's
   * clarification) — those agents' schemaName is in `REPORT_SKIP_SCHEMAS`.
   */
  report?: string;
```

---

### Task 2: `src/agents/types.ts`

**Find:**

```ts
  /**
   * Machine-consumable structured output of this agent run. Surfaced to
   * GraphState.lastStructuredOutput so downstream nodes (next sub-graph
   * step, spawnTasks handler, report-writer) can consume it directly
   * instead of reading prose out of the message stream.
   *
   * Optional — agents added before the report-writer refactor (and any
   * agent that genuinely produces no structured output) leave it unset.
   */
  structuredOutput?: {
```

**Replace with:**

```ts
  /**
   * Machine-consumable structured output of this agent run. Surfaced to
   * GraphState.lastStructuredOutput so downstream nodes (next sub-graph
   * step, spawnTasks handler, report-writer) can consume it directly
   * instead of reading prose out of the message stream.
   *
   * Optional only because `runSupervisor` returns Partial<GraphState>
   * directly (its clarification path has no agent-produced structure).
   * Every IAgent in the registry currently emits one.
   */
  structuredOutput?: {
```

---

### Task 3: `src/agents/builtin/article-writer/index.ts`

**Find:**

```ts
  // NOTE: artifact.report intentionally absent — report-writer fills it in
  // by reading state.lastStructuredOutput. PR1 wired the channel; this is
  // the first agent that uses it in production.
  const result: AgentOutput = {
```

**Replace with:**

```ts
  // NOTE: artifact.report intentionally absent — report-writer fills it in
  // by reading state.lastStructuredOutput.
  const result: AgentOutput = {
```

---

### Task 4: `src/agents/builtin/shopify-publisher/index.ts`

**Find:**

```ts
      // Image markdown for boss-facing display only — Shopify gets images via
      // the `images[]` field, not inline in body_html. Same shape as the
      // designer's bodyWithImages; inlined here rather than shared because the
      // logic is 3 lines and only used in two callsites (PR7 plan §"Architecture").
      const imageMarkdown =
```

**Replace with:**

```ts
      // Image markdown for boss-facing display only — Shopify gets images via
      // the `images[]` field, not inline in body_html. Same shape as the
      // designer's bodyWithImages; inlined here rather than shared because the
      // logic is 3 lines and only used in two callsites.
      const imageMarkdown =
```

---

### Task 5: `src/agents/builtin/shopify-publisher/content.ts`

**Find:**

```ts
/**
 * Platform-agnostic product content produced by product-designer and consumed by
 * publisher agents. Mirrors the artifact shape: body (markdown product
 * description) + refs (machine-readable fields the publisher needs).
 *
 * Post-PR7: the boss-facing prose is rendered by the shared report-writer
 * node from the publisher's own structuredOutput; ProductContent no longer
 * carries it.
 */
export interface ProductContent {
```

**Replace with:**

```ts
/**
 * Platform-agnostic product content produced by product-designer and consumed by
 * publisher agents. Mirrors the artifact shape: body (markdown product
 * description) + refs (machine-readable fields the publisher needs).
 *
 * The boss-facing prose is rendered by the shared report-writer node from
 * the publisher's own structuredOutput; ProductContent intentionally does
 * not carry it.
 */
export interface ProductContent {
```

---

### Task 6: `src/agents/builtin/product-designer/index.ts`

**Find:**

```ts
      // Image markdown moves from `report` (PR5) to `body` (PR6) so images
      // stay user-visible pre-approval after we hand the boss-prose duty to
      // the shared report-writer node.
      const imageMarkdown =
```

**Replace with:**

```ts
      // Image markdown is appended to `artifact.body` (not `body` itself) so
      // images stay user-visible pre-approval. Boss-facing prose is rendered
      // separately by the shared report-writer node.
      const imageMarkdown =
```

---

### Task 7: `src/orchestrator/state.ts`

**Find:**

```ts
  /**
   * Typed inter-node communication channel. Every atomic agent (including
   * those inside workflow sub-graphs) writes this on completion. Consumers:
   * downstream nodes in workflow sub-graphs, the spawnTasks handler, the
   * report-writer node, and `/continue` threading prior output forward.
   *
   * Null while no agent has produced output yet, or when an agent doesn't
   * emit structured output (e.g. before this refactor lands per-agent).
   */
  lastStructuredOutput: Annotation<{
```

**Replace with:**

```ts
  /**
   * Typed inter-node communication channel. Every atomic agent (including
   * those inside workflow sub-graphs) writes this on completion. Consumers:
   * downstream nodes in workflow sub-graphs, the spawnTasks handler, the
   * report-writer node, and `/continue` threading prior output forward.
   *
   * Null on the supervisor clarification path (no agent ran, so no
   * structured output to channel).
   */
  lastStructuredOutput: Annotation<{
```

---

### Task 8: `src/orchestrator/report-writer.ts`

**Find:**

```ts
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
```

**Replace with:**

```ts
/**
 * Boundary node that turns an agent's structured output into boss-facing
 * markdown prose. Wired so the supervisor routes here whenever the next
 * step would have been END or HITL pause — every other hop bypasses it.
 *
 * No-ops (returns `{}`) when:
 *   - `state.lastStructuredOutput` is null (supervisor clarification path —
 *      no agent ran)
 *   - the schemaName is in REPORT_SKIP_SCHEMAS (e.g. eeat-interviewer's
 *      question prompt — agent's hand-written `artifact.report` IS the
 *      boss-facing output and must survive intact)
 *
 * On normal paths, calls a small LLM to render the report and writes it
 * to `state.lastOutput.artifact.report`. Failure is non-fatal: a fallback
 * line is written + a warn log emitted; the task lifecycle is never
 * blocked by report-writer's own errors.
 */
```

Also tighten the constant doc directly above (lines 7-11):

**Find:**

```ts
/**
 * Schemas whose output is NOT a retrospective summary — for these, the
 * agent's own artifact.report (the question prompt, the action invitation)
 * is the right thing for the boss to see, not a meta-narration of it.
 */
const REPORT_SKIP_SCHEMAS = new Set<string>(['eeat-questions']);
```

No change — the comment is already migration-neutral. Leave as-is.

---

### Task 9: `src/orchestrator/graph.ts`

**Find:**

```ts
        // Surface structured output to the inter-node channel. Agents that
        // don't emit structuredOutput leave the channel as-is (the reducer
        // is replace-with-undefined, which a small null guard prevents).
        ...(result.structuredOutput
```

**Replace with:**

```ts
        // Surface structured output to the inter-node channel. The
        // conditional spread tracks the optional field on AgentOutput
        // (kept optional for the supervisor clarification path) — every
        // registered agent in fact emits one.
        ...(result.structuredOutput
```

---

### Task 10: `src/tasks/runner.ts`

**Find:**

```ts
          // Persist the inter-node channel so resume / /continue / spawn
          // children can read it. Stays out of `task.output` when unset to
          // keep the row clean for agents that haven't migrated yet.
          ...(finalState.lastStructuredOutput
```

**Replace with:**

```ts
          // Persist the inter-node channel so resume / /continue / spawn
          // children can read it. Stays out of `task.output` when unset
          // (supervisor clarification path: no agent ran).
          ...(finalState.lastStructuredOutput
```

---

### Task 11: Verify Phase A

```bash
pnpm typecheck             # expect: clean
pnpm lint                  # expect: clean
pnpm test                  # expect: 210 passed (no test changed yet)
```

**Do NOT run integration suite yet** — Phase B will trigger one full integration run; running it twice doubles the wait.

If anything fails: stop. Comment edits should never break compilation, lint, or tests. A failure here means an `Edit` accidentally mangled non-comment code.

---

### Task 12: Commit Phase A

```bash
git add \
  src/tasks/artifact.ts \
  src/agents/types.ts \
  src/agents/builtin/article-writer/index.ts \
  src/agents/builtin/shopify-publisher/index.ts \
  src/agents/builtin/shopify-publisher/content.ts \
  src/agents/builtin/product-designer/index.ts \
  src/orchestrator/state.ts \
  src/orchestrator/report-writer.ts \
  src/orchestrator/graph.ts \
  src/tasks/runner.ts

git commit -m "$(cat <<'EOF'
chore: drop migration-era language from source comments

PR3-7 are landed; comments referring to "before per-agent migrations
land" / "agents that haven't migrated yet" / "PR1 wired the channel" /
etc. are now misleading historical context. Tighten each to describe
present-tense reality (supervisor clarification path is the actual
reason the relevant null-guards exist; eeat-interviewer + supervisor
are the actual reasons artifact.report is still optional).

Zero behavior change — pure comment hygiene. Type checks unchanged,
all 210 unit tests still pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Test comment hygiene (7 files, single commit)

Tests already describe current behavior in their assertions; the "Post-PRn:" tags add no value to a future reader who doesn't know what PR4 / PR5 / PR6 / PR7 was. CLAUDE.md explicitly cautions against "(added for the Y flow)"-style comments because they rot.

Strip the "Post-PRn:" / "(post-PRn)" tags. **Do not change any assertion.** **Do not change anything that wraps a regression-vector explanation** (e.g. the `'CRITICAL: report comes from report-writer'` blocks — those are load-bearing test-discrimination notes; only strip the "Post-PRn" prefix from them, not the body).

### Task 13: `tests/market-researcher.test.ts`

**Find:**

```ts
 * Market Researcher (post-PR3): produces a structured market report. The
```

**Replace with:**

```ts
 * Market Researcher: produces a structured market report. The
```

---

### Task 14: `tests/shopify-publisher.test.ts` — 4 sites

**Site 1 (line 5):**

**Find:**

```ts
 * shopify-publisher (post-PR7): execution agent that converts a ProductContent
```

**Replace with:**

```ts
 * shopify-publisher: execution agent that converts a ProductContent
```

**Site 2 (line 9):**

**Find:**

```ts
 * Post-PR7 contract:
```

**Replace with:**

```ts
 * Contract:
```

**Site 3 (line 16) — keep the technical fact, drop the version pointer:**

**Find:**

```ts
 * - `ProductContent` no longer has a `report` field; designer's mid-migration
 *   plumbing is gone.
 */
```

**Replace with:**

```ts
 * - `ProductContent` does not carry a `report` field — the publisher emits
 *   its own structuredOutput so the designer needs no plumbing for it.
 */
```

**Site 4 (line 90):**

**Find:**

```ts
    // Post-PR7: agent no longer writes report — that's report-writer's job.
    expect(artifact).not.toHaveProperty('report');
```

**Replace with:**

```ts
    // Agent does not write report — that's report-writer's job.
    expect(artifact).not.toHaveProperty('report');
```

---

### Task 15: `tests/product-designer.test.ts` — 4 sites

**Site 1 (line 5):**

**Find:**

```ts
 * product-designer (post-PR7): execution agent that receives a markdown
```

**Replace with:**

```ts
 * product-designer: execution agent that receives a markdown
```

**Site 2 (line 9):**

**Find:**

```ts
 * Post-PR7 contract:
```

**Replace with:**

```ts
 * Contract:
```

**Site 3 (line 150):**

**Find:**

```ts
    // Post-PR7: ProductContent no longer carries `report`. The publisher
    // emits its own structuredOutput so report-writer fills its
    // artifact.report independently.
    expect(content).not.toHaveProperty('report');
```

**Replace with:**

```ts
    // ProductContent does not carry `report`. The publisher emits its own
    // structuredOutput so report-writer fills its artifact.report independently.
    expect(content).not.toHaveProperty('report');
```

**Site 4 (line 202):**

**Find:**

```ts
    // Post-PR7: image markdown rides on artifact.body only. content carries
    // raw fields; the publisher rebuilds bodyWithImages from refs.imageUrls.
```

**Replace with:**

```ts
    // Image markdown rides on artifact.body only. content carries raw
    // fields; the publisher rebuilds bodyWithImages from refs.imageUrls.
```

---

### Task 16: `tests/product-planner.test.ts`

**Find:**

```ts
 * product-planner (post-PR4): strategy agent that researches via Serper and
```

**Replace with:**

```ts
 * product-planner: strategy agent that researches via Serper and
```

---

### Task 17: `tests/integration/product-publisher.test.ts` — 3 sites

**Site 1 (line 158):**

**Find:**

```ts
    // Post-PR4: planner emits structuredOutput → report-writer renders prose.
```

**Replace with:**

```ts
    // Planner emits structuredOutput → report-writer renders prose.
```

**Site 2 (line 219):**

**Find:**

```ts
    // Post-PR6: designer emits structuredOutput → report-writer renders prose.
```

**Replace with:**

```ts
    // Designer emits structuredOutput → report-writer renders prose.
```

**Site 3 (line 274):**

**Find:**

```ts
    // Post-PR7: publisher emits structuredOutput → report-writer renders prose.
```

**Replace with:**

```ts
    // Publisher emits structuredOutput → report-writer renders prose.
```

---

### Task 18: `tests/integration/spawning.test.ts`

**Find:**

```ts
    // Post-PR5: strategist emits structuredOutput → report-writer renders prose.
```

**Replace with:**

```ts
    // Strategist emits structuredOutput → report-writer renders prose.
```

---

### Task 19: `tests/integration/seo-cluster.test.ts`

**Find:**

```ts
    // Post-PR5: strategist emits structuredOutput → report-writer renders prose.
```

**Replace with:**

```ts
    // Strategist emits structuredOutput → report-writer renders prose.
```

---

### Task 20: Verify Phase B

```bash
pnpm typecheck             # expect: clean
pnpm lint                  # expect: clean
pnpm test                  # expect: 210 passed
pnpm test:integration      # expect: 104 passed
```

All four must be clean. If anything fails: an `Edit` damaged a non-comment line.

---

### Task 21: Commit Phase B

```bash
git add \
  tests/market-researcher.test.ts \
  tests/shopify-publisher.test.ts \
  tests/product-designer.test.ts \
  tests/product-planner.test.ts \
  tests/integration/product-publisher.test.ts \
  tests/integration/spawning.test.ts \
  tests/integration/seo-cluster.test.ts

git commit -m "$(cat <<'EOF'
chore(tests): drop "Post-PRn" version tags from test comments

Tests describe current behavior in their assertions; the "Post-PR4 /
PR5 / PR6 / PR7" tags add nothing for a future reader who doesn't know
what those PRs were. Per CLAUDE.md: don't reference current task / fix
in source comments — those belong in the PR description.

No assertion changed. 210 unit + 104 integration still pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Final verify + handoff

### Task 22: Final scope sweep

```bash
grep -rn "PR[0-9]\|pre-PR\|post-PR\|Post-PR\|mid-migration\|haven't migrated\|before this refactor\|before the per-agent\|before the report-writer refactor" src/ tests/ --include="*.ts"
```

Expected: **0 matches** — every PR-era reference removed.

If matches remain: report what's left and add a follow-up edit for each.

> The grep for `migration` alone WILL match drizzle migration code (`src/db/migrate.ts`, `drizzle/**`); the narrowed terms above filter to PR-era language only.

---

### Task 23: Hand off to finishing-a-development-branch

Announce: "I'm using the finishing-a-development-branch skill to complete this work."

Use `superpowers:finishing-a-development-branch` to present merge / PR / keep / discard options. Plan author's expectation (matching PR3-7 cadence) is **option 1: merge to main locally** — push happens manually after.

---

## Verification matrix

| Check | Command | Expected |
|---|---|---|
| Unit suite | `pnpm test` | 210 passed (same as PR7 baseline) |
| Integration suite | `pnpm test:integration` | 104 passed (same as PR7 baseline) |
| Type check | `pnpm typecheck` | clean |
| Lint | `pnpm lint` | clean |
| Final sweep | grep above | 0 matches |

**Test counts MUST be identical to the PR7 baseline.** This PR adds nothing testable; it removes nothing testable. If counts differ, an edit accidentally deleted a test or changed an assertion.

---

## Why this PR is small

The design doc PR10 entry said "Remove deprecated `artifact.report`-from-agent codepath; Remove any backwards-compat shims accumulated during migration; Tidy supervisor prompt." Surveying the code post-PR7:

- **The "deprecated codepath" was not a single deletable codepath.** The relevant null-guards (`if (!sout)`) in report-writer + the conditional spreads in graph + runner are still load-bearing for the supervisor clarification path and the `eeat-questions` skip path. They look like migration shims but turned out to be permanent fixtures.
- **There were no real backwards-compat shims.** Each PR3-7 was a clean drop — no aliases, no redirect layers, no legacy field reads. The mid-migration plumbing in PR6's `payload.content.report = bodyWithImages` was already deleted in PR7.
- **The supervisor prompt has no migration-era language.** It's about routing rules, not about which agents have been migrated.

So PR10's actual scope shrank to comment hygiene. That's the whole job.
