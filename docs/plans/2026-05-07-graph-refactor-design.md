# LangGraph Architecture Refactor — Design

**Date:** 2026-05-07
**Status:** Approved, ready for implementation plan
**Depends on:** None (no schema migrations; jsonb passthrough on `task.output`)

## Problem

The current orchestrator has a clean star topology — `supervisor ↔ atomic agents` only — and that's mostly the right shape. But three smells have built up:

1. **Agents have two responsibilities glued together.** Every atomic agent's submit schema includes both a structured deliverable (article, plan, research report) AND a `report` markdown field whose only job is "narrate this for the boss." The boss-facing prose is a different responsibility from producing the deliverable, but today it's bolted on to every agent's prompt and schema. The 6 agents reinvent the same "report style" in 6 different prompts; the result drifts in tone.

2. **Multi-step flows have nowhere to live.** When a use case naturally spans multiple agents in a fixed order (e.g. EEAT-interview → article-write, or research → plan → write-cluster), today's options are:
   - Hide the multi-step logic *inside* one agent's invoke (what `shopify-blog-writer` does with `shouldDoStage1` — the flow is invisible from the graph topology)
   - Use task-level `/continue` chains (user has to manually click through)
   - Use `seo-strategist`'s spawn fan-out (turns one task into N child tasks; not the same as a sequential pipeline)
   None of these make the workflow a first-class, grep-able, version-controlled object.

3. **`shopify-blog-writer` violates SRP.** It does EEAT interviewing, SERP research, web fetching, article writing, cover image generation, AND publishing prep — six things in one agent. The most concrete pain point: Stage 1 (ask EEAT questions) and Stage 2 (write article) are two genuinely different responsibilities held together by a `shouldDoStage1` branch in the invoke function.

## Goals

- **Sub-graphs as first-class workflows.** Multi-step flows registered alongside atomic agents in the same registry; supervisor routes to them like any other agent. Pattern C from the brainstorm: workflow IS an `IAgent`.
- **Structured output as the inter-node bus.** Add a `lastStructuredOutput` channel to GraphState that carries typed agent output between nodes. Report-writing becomes a separate node consuming this channel.
- **Single shared `report-writer` node** that fires only at HITL boundaries / END. Boss-facing prose has one author, one prompt template, one consistent voice across the system.
- **Atomic agents stay first-responsibility.** Each agent produces one machine-consumable deliverable. EEAT interviewing splits out into its own atomic agent.
- **Open path preserved.** Supervisor still does free-form routing for briefs that don't match a known workflow. Atomic agents and workflow agents coexist in the registry.

## Non-goals

- **Replacing the supervisor.** The supervisor LLM's per-hop reasoning is the most important capability of the current architecture; we are not turning the system into a fixed pipeline.
- **LangGraph nested checkpointing.** Sub-graphs are stateless routers driven by stage flags in `task.output`. We deliberately don't use LangGraph's `interrupt()` primitive or nested checkpoint persistence — keeps debugging in SQL, avoids version-upgrade fragility, fits the codebase's "idempotent boundaries" philosophy. Re-evaluate when a workflow grows past 3 nodes / 1 HITL pause.
- **Dual-write / shadow mode.** No production traffic yet. Each PR cuts over directly.
- **Backwards-compat for `IAgent` schema during the migration.** Each PR migrates one agent in one cut. No deprecation aliases.
- **A separate `shopify-blog-publisher`** at first. Article-writer keeps `shopify.publish_article` tool initially; splitting publishing into its own agent is PR9 (deferred until after the bulk migration).
- **`research-and-cluster` or other workflow sub-graphs beyond EEAT.** PR2 ships exactly one workflow (`seo-article-with-eeat`); subsequent workflows added on demand once the mechanism is proven.

## Architecture

```
                ┌──────────────────────────────────────────┐
                │                                          │
START → supervisor → conditional:                          │
            │   awaitingApproval || !nextAgent → report-writer → END
            │   nextAgent → ↓                              │
            │                                              │
            ├─ market-researcher ──────────────────────────┤
            ├─ seo-strategist ─────────────────────────────┤
            ├─ eeat-interviewer  (new, atomic) ────────────┤
            ├─ article-writer  (renamed, atomic) ──────────┤
            ├─ product-planner ────────────────────────────┤
            ├─ product-designer ───────────────────────────┤
            ├─ shopify-publisher ──────────────────────────┤
            ├─ seo-article-with-eeat (new, workflow) ──────┤
            └─ ... future workflows ───────────────────────┘
                                                           │
            (every node returns to supervisor)─────────────┘
```

Three concepts:

- **Atomic agent** — produces one machine-consumable deliverable + a one-line progressNote. Today's set of agents, slimmed down to first-responsibility.
- **Workflow sub-graph** — registered as `IAgent` (Pattern C). Internally compiles a LangGraph `StateGraph` that wires multiple atomic agents into a fixed sequence with stage-flag-driven routing. Looks indistinguishable from an atomic agent to the supervisor.
- **`report-writer` node** — shared boundary node. Reads `lastStructuredOutput` and produces boss-facing markdown into `lastOutput.artifact.report`. Fires only when the supervisor decides we're going to HITL or END.

### `GraphState` changes

```ts
GraphStateAnnotation = Annotation.Root({
  // unchanged: tenantId, taskId, messages, params, taskImageIds,
  //            pinnedAgent, awaitingApproval, currentTaskOutput, nextAgent

  // NEW: typed inter-node bus. Every atomic agent (including those inside
  // workflow sub-graphs) writes this on completion. Consumed by:
  //   - downstream nodes in workflow sub-graphs
  //   - spawnTasks handler (e.g. strategist → child input)
  //   - report-writer
  //   - supervisor (potential future use as routing signal)
  //   - /continue to thread prior output as context into a new task
  lastStructuredOutput: Annotation<{
    agentId: string;
    schemaName: string;          // 'article-draft' | 'topic-plan' | 'market-report' | 'eeat-questions' | ...
    data: Record<string, unknown>;
    keyDecisions?: string[];     // hints for report-writer's "why" prose
  } | null>(...),

  // CHANGED semantics (shape unchanged):
  //   artifact.body / refs : agent writes directly  (machine-readable persistent deliverable)
  //   artifact.report      : report-writer writes   (was: agent wrote)
  lastOutput: Annotation<{ ... unchanged shape ... }>(...),
})
```

`lastStructuredOutput` is also persisted to `task.output.lastStructuredOutput` so resume / `/continue` / spawn children can read it.

### `IAgent` contract changes

```ts
interface AgentOutput {
  // unchanged
  message: string;
  awaitingApproval?: boolean;
  payload?: Record<string, unknown>;
  spawnTasks?: SpawnTaskRequest[];
  pendingToolCall?: PendingToolCall;

  // CHANGED: artifact no longer carries report from the agent
  artifact?: {
    body?: string;
    refs?: Record<string, unknown>;
    // report?: string;  ← removed; report-writer populates this
  };

  // NEW: structured output for the inter-node bus
  structuredOutput?: {
    schemaName: string;
    data: Record<string, unknown>;
    keyDecisions?: string[];
  };
}
```

`IAgent.manifest.metadata` gains an optional `shape: 'atomic' | 'workflow'` — pure metadata, no behavioral effect on the graph. Used by supervisor's prompt to flag workflows as "use when the brief is multi-step and matches the workflow's specialty."

### `report-writer` node

Lives at `src/orchestrator/report-writer.ts`. Reads `state.lastStructuredOutput` + brief + `state.lastOutput.artifact.body/refs`. Produces a 300–800-character zh-TW markdown report and writes it to `state.lastOutput.artifact.report`.

System prompt is shared across all schema types (one consistent narrative voice). Per-schema user-prompt templates customize what to emphasize:

```ts
const REPORT_TEMPLATES: Record<string, (input) => string> = {
  'topic-plan':    (i) => `... emphasize: overall strategy, why these topics, competitor gap ...`,
  'article-draft': (i) => `... emphasize: angle, EEAT hooks, differentiation ...`,
  'market-report': (i) => `... emphasize: market observation, competitors, gap, recommendation ...`,
  // ... extend per new schemaName
};

const REPORT_SKIP_SCHEMAS = new Set([
  'eeat-questions',  // interviewer's output is action-prompt, not retrospective summary
]);
```

EEAT opt-out is by `schemaName` membership in `REPORT_SKIP_SCHEMAS` — `eeat-interviewer` still writes `lastStructuredOutput` (so downstream `article-writer` can read questions/answers), but report-writer skips rendering and the interviewer's own `artifact.report` (the question prompt) survives unchanged.

Model: `claude-haiku-4-5` (~5x cheaper than the agents' Sonnet for a task it doesn't need strong reasoning for). Failure mode: try/catch + fallback prose + warn-level emitLog; never fails the task.

### Workflow sub-graph contract

Sub-graph is a stateless router compiled fresh on each `agent.build()` call. **Does not use LangGraph nested checkpointing.** Every entry re-routes from `START` based on `state.currentTaskOutput` flags.

Every workflow follows this contract:

1. **Stage flags live in `task.output` with a workflow-id prefix** (e.g. `eeatPending`, `researchAndCluster_planDone`)
2. **Sub-graph `START` conditional only reads `currentTaskOutput`** — no internal sub-graph state, no LangGraph checkpoint dependence
3. **Sub-graph END writes `lastStructuredOutput` and `awaitingApproval`** to outer state; `lastOutput.agentId` is the **outer-facing workflow id** (`'seo-article-with-eeat'`), not the internal node name
4. **No nested workflows** — a workflow sub-graph cannot route to another workflow sub-graph as one of its nodes (one level of nesting maximum)

Concrete shape for `seo-article-with-eeat` (PR2 version, 2 nodes):

```ts
function buildSeoArticleWithEeatSubGraph(ctx: AgentBuildContext) {
  return new StateGraph(SubState)
    .addNode('eeat-interviewer', runEeatInterviewer(ctx))
    .addNode('article-writer',   runArticleWriter(ctx))

    .addConditionalEdges(START, (state) => {
      const out = state.currentTaskOutput ?? {};
      const eeatAsked    = !!out.eeatPending;
      const eeatAnswered = lastMessageIsFromUser(state.messages);
      const skipEeat     = state.params?.skipEeat === true || !ctx.cfg.eeatEnabled;

      if (skipEeat)                  return 'article-writer';
      if (!eeatAsked)                return 'eeat-interviewer';
      if (eeatAsked && eeatAnswered) return 'article-writer';
      return 'article-writer';
    })
    .addEdge('eeat-interviewer', END)
    .addEdge('article-writer',   END)
    .compile();    // no checkpointer
}
```

### HITL resume — two layers of memory

| Layer | Mechanism | Stored where |
|---|---|---|
| **Layer 1** (which sub-graph after resume) | `lastOutput.agentId` + supervisor's continuity-bias prompt + runner copies it to `pinnedAgent` to short-circuit the supervisor LLM | `task.output` (GraphState checkpoint) |
| **Layer 2** (which node inside sub-graph) | `task.output.<stage_flag>` + sub-graph's `START` conditional | `task.output` (jsonb passthrough) |

Runner gains a small enhancement: when resuming a task whose `awaitingApproval` was just released (i.e. `messages` last entry is from the user), set `state.pinnedAgent = state.lastOutput?.agentId`. Supervisor's existing pinned-agent short-circuit then routes deterministically without an LLM call.

## Migration plan (PR sequence)

Path C × β: small, incremental PRs, pain-first ordering. Each PR is self-contained and main is always green.

### PR1 — `report-writer` infrastructure
- Add `lastStructuredOutput` annotation to `GraphState`
- New `src/orchestrator/report-writer.ts`
- Wire conditional edge: `awaitingApproval || !nextAgent → 'report-writer' → END`
- No agent changes; agents continue to write `artifact.report` themselves
- Report-writer is a no-op when `lastStructuredOutput` is null
- **Behavior change:** none. Production runs identically.
- **Risk:** very low

### PR2 — Split EEAT + first workflow sub-graph
- New `src/agents/builtin/eeat-interviewer/` (atomic)
- New `src/agents/builtin/article-writer/` (renamed and pruned `shopify-blog-writer`; keeps `shopify.publish_article` tool)
- New `src/agents/builtin/seo-article-with-eeat/` (workflow sub-graph wiring the above two)
- All three registered in `bootstrapAgents()`; old `shopify-blog-writer` removed entirely
- Both new atomic agents emit `lastStructuredOutput` and stop emitting `artifact.report`
- Integration tests for `shopify-blog-writer*.test.ts` rewritten to cover the new workflow + atomic pair
- Supervisor prompt updated: workflow agents flagged as "prefer when the brief matches a multi-step pattern"
- **Risk:** medium — first production-grade test of sub-graph + HITL resume

### PR3–7 — Migrate remaining atomic agents (one per PR)

Order by complexity ascending:
- **PR3:** `market-researcher`
- **PR4:** `product-planner`
- **PR5:** `seo-strategist`
- **PR6:** `product-designer`
- **PR7:** `shopify-publisher` (also rename → `shopify-product-publisher` for symmetry with future blog publisher)

Each PR's scope:
1. Remove `report` field from the agent's submit schema
2. Add `keyDecisions: string[]` (optional)
3. Agent invoke writes `lastStructuredOutput` and `artifact.body/refs`; no longer writes `artifact.report`
4. Update integration test scripts for that agent

Mid-migration state is fully functional: agents not yet migrated still produce `artifact.report` themselves; agents already migrated produce nothing in that field, and report-writer fills it in. Both modes coexist cleanly because report-writer no-ops when `lastStructuredOutput` is null.

### PR8 — Second workflow sub-graph (optional, on demand)
Add only if a concrete use case appears (e.g. `research-and-cluster`). No speculative additions.

### PR9 — Split publisher + multi-platform support (much later)
- New `shopify-blog-publisher` atomic agent
- `article-writer` loses `shopify.publish_article` tool
- `seo-article-with-eeat` workflow internally wires 3 stages: interviewer → writer → publisher
- Lays groundwork for future `wordpress-blog-publisher` etc. as plug-ins

### PR10 — Cleanup
- Remove deprecated `artifact.report`-from-agent codepath
- Remove any backwards-compat shims accumulated during migration
- Tidy supervisor prompt

## Risks

**R1 — `pinnedAgent` resume short-circuit logic complexity**
Resume detection (lastOutput.agentId set + awaitingApproval just cleared + messages last is user) is off-by-one bait. **Mitigation:** dedicated unit tests covering 4 resume paths (first-run / feedback / approve / discard). **Fallback:** if the short-circuit breaks, the supervisor LLM still routes (probably correctly) — degraded performance, not broken behavior.

**R2 — Sub-graph stage-flag naming collisions**
Future workflows could collide on `task.output` flag names. **Mitigation:** convention — flag names prefixed with workflow id (e.g. `researchAndCluster_planDone`). Document in sub-graph contract.

**R3 — Supervisor inconsistent routing between atomic and workflow**
Supervisor LLM might oscillate between `article-writer` (atomic) and `seo-article-with-eeat` (workflow) for similar briefs. **Mitigation:** workflow `manifest.description` very specific ("only use when X+Y+Z together"); atomic descriptions stress single-action; temperature stays at 0.2. Worst case is degraded efficiency, not wrong outcome.

**R4 — `lastStructuredOutput` size bloat**
Strategist's topic plan is large (10 topics × ~2KB writerBrief each). **Mitigation:** none initially — the same data already round-trips through `output.spawnTasks` today. Add a size guard if it ever bites.

**R5 — Report-writer silent failure**
LLM call could fail and produce ugly fallback prose. **Mitigation:** retry once (haiku is cheap), log error, emit timeline event, never fail the task.

**R6 — LangGraph compile time**
Each task run rebuilds the graph via `buildGraph`. More agents + workflows = more nodes. **Mitigation:** monitor; expected sub-100ms even at 10+ agents. Cache lazily if it ever becomes an issue.

**R7 — PR2 integration test cliff**
PR2 deletes `shopify-blog-writer` and rewrites the test suite simultaneously. **Mitigation:** structure PR2 commits so tests are added before old agent is removed; CI green after each commit.

## Open questions

- **Q1:** Are there in-flight tasks in dev DB carrying `task.output.eeatPending` from old `shopify-blog-writer`? Sub-graph's `START` conditional still recognizes that flag, so should be backward-compatible — confirm before PR2.
- **Q2:** Final `IAgent.manifest.metadata.kind` semantics. Today: `'strategy' | 'execution'`. Add `'workflow'` orthogonally, or treat workflows as a third kind?

## Trace example

End-to-end for "規劃 + 寫一篇含 EEAT 的文" after the refactor:

```
[Hop 1] START → supervisor (LLM: routes to seo-article-with-eeat) → seo-article-with-eeat
[Hop 2]   sub: eeat-interviewer (produces EEAT questions, lastStructuredOutput.schemaName='eeat-questions')
          → sub-END (awaitingApproval=true)
[Hop 3] outer: → supervisor → conditional → report-writer
        report-writer sees schemaName='eeat-questions' → SKIP; interviewer's artifact.report (question prompt) preserved
[Hop 4] → END (task = waiting)

[user answers EEAT questions via /feedback → task = todo]

[Hop 5] outer: supervisor (pinned via lastOutput.agentId='seo-article-with-eeat') → seo-article-with-eeat
[Hop 6]   sub: START conditional sees eeatAsked=true + lastMessageIsFromUser → article-writer
          article-writer reads EEAT answers from messages, writes article, emits lastStructuredOutput.schemaName='article-draft'
          → sub-END (awaitingApproval=true, pendingToolCall=shopify.publish_article)
[Hop 7] outer: → supervisor → conditional → report-writer
        report-writer renders 'article-draft' → boss-facing prose into artifact.report
[Hop 8] → END (task = waiting, artifact ready, pendingToolCall queued)

[user approve(finalize=true) → publish_article fires → task = done]
```
