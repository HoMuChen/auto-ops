# Graph Refactor PR1: report-writer Infrastructure — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land the `report-writer` graph node and `lastStructuredOutput` GraphState channel as dead infrastructure — wired in but not yet used by any agent. Production behavior must be identical before and after this PR.

**Architecture:** Add a new annotation to `GraphState`, a new optional field to `AgentOutput`, a new node `report-writer` between `supervisor` and `END`, and the persistence plumbing so `lastStructuredOutput` round-trips through `task.output`. Because no agent in this PR emits `structuredOutput`, the new node always no-ops in production paths — guaranteeing zero behavior change.

**Tech Stack:** TypeScript, LangGraph (`@langchain/langgraph`), LangChain core messages, vitest, Drizzle ORM, postgres-js. House LLM gateway is OpenRouter via `buildModel()`. Test style: vi.mock for unit, real Supabase for integration.

**Design ref:** `docs/plans/2026-05-07-graph-refactor-design.md` §2 (state), §3 (AgentOutput), §4 (nodes/edges), §6 (report-writer).

---

## Pre-flight

Before starting, run these once to baseline:

```bash
pnpm typecheck     # expect: no errors
pnpm lint          # expect: no errors
pnpm test          # expect: 194 passed
```

If the baseline isn't green, stop and investigate — this PR is supposed to land on a clean main.

---

## Task 1: Add `lastStructuredOutput` annotation to `GraphState`

**Files:**
- Modify: `src/orchestrator/state.ts`

**What:** Add a new annotation. The reducer is replace (latest wins, no merging) since each agent emits its own complete output. Default null. Persistence to `task.output.lastStructuredOutput` happens in Task 3 — this task is just the in-memory channel.

**Step 1: Edit state.ts**

Add after the `currentTaskOutput` annotation:

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
    agentId: string;
    schemaName: string;
    data: Record<string, unknown>;
    keyDecisions?: string[];
  } | null>({
    reducer: (_curr, next) => next,
    default: () => null,
  }),
```

**Step 2: Verify typecheck still passes**

Run: `pnpm typecheck`
Expected: no errors

**Step 3: Commit**

```bash
git add src/orchestrator/state.ts
git commit -m "feat(graph): add lastStructuredOutput annotation to GraphState

Typed inter-node channel for the upcoming report-writer node and
workflow sub-graph nodes. Null until agents start emitting structured
output (later PRs); no behavioral effect on its own."
```

---

## Task 2: Add `structuredOutput` field to `AgentOutput`

**Files:**
- Modify: `src/agents/types.ts:205-228`

**What:** Optional field. Every existing agent will continue to omit it; the runner code added in Task 3 only acts on it when present.

**Step 1: Edit types.ts**

In `interface AgentOutput`, add after `pendingToolCall?: PendingToolCall;`:

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
    schemaName: string;
    data: Record<string, unknown>;
    keyDecisions?: string[];
  };
```

**Step 2: Verify typecheck still passes**

Run: `pnpm typecheck`
Expected: no errors (existing agents don't break — the field is optional)

**Step 3: Commit**

```bash
git add src/agents/types.ts
git commit -m "feat(agents): add optional structuredOutput field to AgentOutput

Lets agents emit machine-readable structured output that downstream
nodes (workflow steps, report-writer) can consume directly. No agent
emits this yet; existing agents continue to work unchanged."
```

---

## Task 3: Plumb `structuredOutput` from agent → state → `task.output`

**Files:**
- Modify: `src/orchestrator/graph.ts:116-128` (agent node return)
- Modify: `src/tasks/runner.ts:174-185` (persistedOutput composition)

**What:** Two small additions:
1. The graph's per-agent node copies `result.structuredOutput` (when set) into `state.lastStructuredOutput`
2. The runner persists `finalState.lastStructuredOutput` (when set) into `task.output.lastStructuredOutput` so resume / `/continue` / spawn children can read it

**Step 1: Edit graph.ts**

In the per-agent node return block (around line 116-128), add the new state field. The current return looks like:

```ts
      return {
        messages: [new AIMessage(result.message)],
        lastOutput: { ... },
        awaitingApproval: result.awaitingApproval ?? false,
        nextAgent: null,
      };
```

Change to:

```ts
      return {
        messages: [new AIMessage(result.message)],
        lastOutput: {
          agentId: manifest.id,
          message: result.message,
          payload: result.payload,
          ...(result.artifact ? { artifact: result.artifact } : {}),
          ...(result.spawnTasks ? { spawnTasks: result.spawnTasks } : {}),
          ...(result.pendingToolCall ? { pendingToolCall: result.pendingToolCall } : {}),
        },
        // Surface structured output to the inter-node channel. Agents that
        // don't emit structuredOutput leave the channel as-is (the reducer
        // is replace-with-undefined, which a small null guard prevents).
        ...(result.structuredOutput
          ? {
              lastStructuredOutput: {
                agentId: manifest.id,
                schemaName: result.structuredOutput.schemaName,
                data: result.structuredOutput.data,
                ...(result.structuredOutput.keyDecisions
                  ? { keyDecisions: result.structuredOutput.keyDecisions }
                  : {}),
              },
            }
          : {}),
        awaitingApproval: result.awaitingApproval ?? false,
        nextAgent: null,
      };
```

**Step 2: Edit runner.ts**

Change the `persistedOutput` composition (lines 174-185) to include `lastStructuredOutput`. Currently:

```ts
    const persistedOutput = finalState.lastOutput
      ? {
          ...(finalState.lastOutput.payload ?? {}),
          ...(finalState.lastOutput.artifact ? { artifact: finalState.lastOutput.artifact } : {}),
          ...(finalState.lastOutput.spawnTasks
            ? { spawnTasks: finalState.lastOutput.spawnTasks }
            : {}),
          ...(finalState.lastOutput.pendingToolCall
            ? { pendingToolCall: finalState.lastOutput.pendingToolCall }
            : {}),
        }
      : null;
```

Change to:

```ts
    const persistedOutput = finalState.lastOutput
      ? {
          ...(finalState.lastOutput.payload ?? {}),
          ...(finalState.lastOutput.artifact ? { artifact: finalState.lastOutput.artifact } : {}),
          ...(finalState.lastOutput.spawnTasks
            ? { spawnTasks: finalState.lastOutput.spawnTasks }
            : {}),
          ...(finalState.lastOutput.pendingToolCall
            ? { pendingToolCall: finalState.lastOutput.pendingToolCall }
            : {}),
          // Persist the inter-node channel so resume / /continue / spawn
          // children can read it. Stays out of `task.output` when unset to
          // keep the row clean for agents that haven't migrated yet.
          ...(finalState.lastStructuredOutput
            ? { lastStructuredOutput: finalState.lastStructuredOutput }
            : {}),
        }
      : null;
```

**Step 3: Verify typecheck and existing tests still pass**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, 194 tests pass (no agent emits structuredOutput, so the new branches are unreached and behavior is identical)

**Step 4: Commit**

```bash
git add src/orchestrator/graph.ts src/tasks/runner.ts
git commit -m "feat(graph): plumb structuredOutput from agent → state → task.output

Agent node copies result.structuredOutput into state.lastStructuredOutput;
runner persists it to task.output.lastStructuredOutput. Both branches
are unreached today (no agent sets the field); they wire up the channel
for the upcoming report-writer node and workflow sub-graphs."
```

---

## Task 4: report-writer — failing test for no-op when `lastStructuredOutput` is null

**Files:**
- Create: `tests/orchestrator-report-writer.test.ts`

**What:** Start the test file. The first behavior to lock in is the most important: when no agent has emitted structured output, report-writer is a pass-through that does NOT call the LLM and does NOT modify state. This is what guarantees PR1's zero-behavior-change property.

Use vi.mock on `buildModel` to make any LLM invocation a test failure.

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';

const buildModelMock = vi.fn(() => {
  throw new Error('buildModel must not be called when lastStructuredOutput is null');
});
vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: buildModelMock,
}));

const { runReportWriter } = await import('../src/orchestrator/report-writer.js');

describe('runReportWriter — no-op paths', () => {
  it('returns an empty patch when lastStructuredOutput is null', async () => {
    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [],
      params: {},
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: null,
      lastStructuredOutput: null,
      awaitingApproval: false,
      currentTaskOutput: null,
      taskImageIds: null,
    };

    const result = await runReportWriter(state);

    expect(result).toEqual({});
    expect(buildModelMock).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/orchestrator-report-writer.test.ts`
Expected: FAIL with "Cannot find module '../src/orchestrator/report-writer.js'"

**Step 3: (no commit yet — we commit when test passes in next task)**

---

## Task 5: report-writer — minimal implementation that makes the no-op test pass

**Files:**
- Create: `src/orchestrator/report-writer.ts`

**What:** The minimal implementation that makes Task 4's test pass — return `{}` if `lastStructuredOutput` is null. Don't add any other logic yet.

**Step 1: Write the minimal implementation**

```ts
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
```

**Step 2: Run the test to verify it passes**

Run: `pnpm vitest run tests/orchestrator-report-writer.test.ts`
Expected: PASS — the no-op test now passes

**Step 3: Commit**

```bash
git add src/orchestrator/report-writer.ts tests/orchestrator-report-writer.test.ts
git commit -m "feat(orchestrator): add report-writer node skeleton with null no-op path

First slice — when state.lastStructuredOutput is null, return an empty
patch and never call the LLM. This is the path every existing agent
flows through today (none of them emit structuredOutput yet) and
guarantees zero behavior change while the rest of the node is being
built up."
```

---

## Task 6: report-writer — failing test for skip-schema path (eeat-questions)

**Files:**
- Modify: `tests/orchestrator-report-writer.test.ts`

**What:** Add a test that locks in the EEAT opt-out: when `lastStructuredOutput.schemaName === 'eeat-questions'`, report-writer returns `{}` and does NOT call the LLM. (Per design §6 — EEAT interviewer's output is action-prompt, not summary; report-writer skips rendering.)

**Step 1: Add the failing test**

Append inside the existing `describe('runReportWriter — no-op paths', ...)`:

```ts
  it('returns an empty patch when schemaName is in REPORT_SKIP_SCHEMAS (eeat-questions)', async () => {
    buildModelMock.mockClear();
    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [],
      params: {},
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: {
        agentId: 'eeat-interviewer',
        message: 'asked questions',
        artifact: { report: 'existing question prompt — must be preserved' },
      },
      lastStructuredOutput: {
        agentId: 'eeat-interviewer',
        schemaName: 'eeat-questions',
        data: { questions: [{ question: 'How long have you worn linen?' }] },
      },
      awaitingApproval: true,
      currentTaskOutput: null,
      taskImageIds: null,
    };

    const result = await runReportWriter(state);

    expect(result).toEqual({});
    expect(buildModelMock).not.toHaveBeenCalled();
  });
```

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/orchestrator-report-writer.test.ts`
Expected: FAIL — current implementation falls through to the second `return {}`, but it does so without checking schema; this test currently passes incidentally (because the function ignores schemaName entirely). To make this test express real intent, change the assertion or fail on a different angle.

**Important refinement:** Because the current `return {};` at the bottom incidentally satisfies the test, this isn't a true red-light. Tighten Task 6 by adding a *positive* test in Task 8 (LLM rendering) — the skip test will turn red the moment we add LLM rendering, since rendering would call buildModelMock. So Task 6's value is locking in the contract for later regressions, even if it's green-on-green right now.

**Step 3: (no commit — see Task 7)**

---

## Task 7: report-writer — implement skip-schema list

**Files:**
- Modify: `src/orchestrator/report-writer.ts`

**What:** Add the explicit skip-schema set. This is the line of code Task 6's test will protect once Task 8 introduces LLM rendering.

**Step 1: Edit report-writer.ts**

Add the set above the function and check it:

```ts
import type { GraphState } from './state.js';

/**
 * Schemas whose output is NOT a retrospective summary — for these, the
 * agent's own artifact.report (the question prompt, the action invitation)
 * is the right thing for the boss to see, not a meta-narration of it.
 */
const REPORT_SKIP_SCHEMAS = new Set<string>(['eeat-questions']);

export async function runReportWriter(state: GraphState): Promise<Partial<GraphState>> {
  const sout = state.lastStructuredOutput;
  if (!sout) return {};
  if (REPORT_SKIP_SCHEMAS.has(sout.schemaName)) return {};
  return {};
}
```

**Step 2: Run the test suite**

Run: `pnpm vitest run tests/orchestrator-report-writer.test.ts`
Expected: PASS (both no-op tests green)

**Step 3: Commit**

```bash
git add src/orchestrator/report-writer.ts tests/orchestrator-report-writer.test.ts
git commit -m "feat(report-writer): skip rendering for eeat-questions schema

EEAT interviewer's structuredOutput is the question list itself; the
agent's own artifact.report is the action prompt the boss should see.
Render-on-top of that would be redundant. The skip set lives at module
scope so future schemas can opt out by adding their name."
```

---

## Task 8: report-writer — failing test for LLM-rendered report path

**Files:**
- Modify: `tests/orchestrator-report-writer.test.ts`

**What:** Test the happy path — a non-skip schema produces an LLM-rendered report written into `lastOutput.artifact.report`. Mock the LLM with `vi.fn` returning a fake AIMessage.

**Step 1: Add the failing test**

Need to swap the buildModelMock from "always throw" to "return a fake model" for this case. Refactor the mock setup at the top of the file:

```ts
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
const buildModelMock = vi.fn(() => ({
  invoke: invokeMock,
}));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: buildModelMock,
}));

const { runReportWriter } = await import('../src/orchestrator/report-writer.js');

beforeEach(() => {
  invokeMock.mockReset();
  buildModelMock.mockClear();
});

// ... existing no-op tests adjusted to check `invokeMock`/`buildModelMock` ...
// Update the null-state test to assert `expect(buildModelMock).not.toHaveBeenCalled()`
// (no change needed beyond clearing in beforeEach).
```

Then add the rendering test:

```ts
import { HumanMessage } from '@langchain/core/messages';

describe('runReportWriter — LLM rendering', () => {
  it('renders boss-facing markdown into lastOutput.artifact.report for normal schemas', async () => {
    invokeMock.mockResolvedValueOnce(
      new AIMessage('## 切角\n\n從機能性切入...\n\n## EEAT 強化點\n\n用實穿經驗開頭。'),
    );

    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [new HumanMessage('幫我寫一篇 2026 夏季女裝穿搭文')],
      params: {},
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: {
        agentId: 'article-writer',
        message: 'draft done',
        artifact: { body: '# Article body markdown', refs: { title: 'Summer linen', slug: 'summer-linen' } },
      },
      lastStructuredOutput: {
        agentId: 'article-writer',
        schemaName: 'article-draft',
        data: { title: 'Summer linen', body: '# Article body markdown' },
        keyDecisions: ['用機能性切入', '開頭塞 EEAT 數字'],
      },
      awaitingApproval: true,
      currentTaskOutput: null,
      taskImageIds: null,
    };

    const result = await runReportWriter(state);

    expect(buildModelMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.lastOutput?.artifact?.report).toContain('切角');
    // body and refs must be preserved from the input state.
    expect(result.lastOutput?.artifact?.body).toBe('# Article body markdown');
    expect(result.lastOutput?.artifact?.refs).toEqual({ title: 'Summer linen', slug: 'summer-linen' });
    // agentId / message must also survive intact.
    expect(result.lastOutput?.agentId).toBe('article-writer');
    expect(result.lastOutput?.message).toBe('draft done');
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/orchestrator-report-writer.test.ts`
Expected: FAIL — current report-writer returns `{}` for non-skip schemas; the test expects `result.lastOutput.artifact.report` to be set

**Step 3: (no commit — implement next)**

---

## Task 9: report-writer — implement LLM rendering

**Files:**
- Modify: `src/orchestrator/report-writer.ts`

**What:** Build the prompt and call `buildModel(...).invoke(...)`. Render system prompt + per-schema user template. For now, ship a generic template — per-schema customization tightens incrementally as agents migrate.

**Step 1: Replace the bottom `return {}` with the rendering implementation**

```ts
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { buildModel } from '../llm/model-registry.js';
import type { ModelConfig } from '../llm/types.js';
import type { GraphState } from './state.js';

const REPORT_SKIP_SCHEMAS = new Set<string>(['eeat-questions']);

const REPORT_MODEL: ModelConfig = {
  model: 'anthropic/claude-haiku-4-5',
  temperature: 0.4,
};

const SYSTEM_PROMPT = `你是這個團隊的敘述者。基於 agent 剛產出的結構化資料，寫一段給老闆看的 zh-TW 繁體中文 Markdown 匯報。
語氣：員工書面回報老闆，300-800 字，可用 ## / ### 子標題、**粗體**、- 條列。
重點放在：
1. 我做了什麼決定
2. 為什麼這樣選
3. 老闆要特別看哪裡
不要逐字背誦結構化資料的內容（老闆會直接看 artifact）。`;

function buildUserPrompt(input: {
  brief: string;
  agentId: string;
  schemaName: string;
  data: Record<string, unknown>;
  keyDecisions?: string[];
}): string {
  const decisionsBlock = input.keyDecisions?.length
    ? `\n關鍵決策（agent 自述）:\n${input.keyDecisions.map((d) => `- ${d}`).join('\n')}`
    : '';
  return `任務 brief: ${input.brief}
Agent: ${input.agentId}
產出類型: ${input.schemaName}

結構化資料:
${JSON.stringify(input.data, null, 2)}${decisionsBlock}`;
}

export async function runReportWriter(state: GraphState): Promise<Partial<GraphState>> {
  const sout = state.lastStructuredOutput;
  if (!sout) return {};
  if (REPORT_SKIP_SCHEMAS.has(sout.schemaName)) return {};

  const briefMessage = state.messages[0];
  const brief =
    typeof briefMessage?.content === 'string'
      ? briefMessage.content
      : JSON.stringify(briefMessage?.content ?? '');

  const model = buildModel(REPORT_MODEL);
  const response = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(
      buildUserPrompt({
        brief,
        agentId: sout.agentId,
        schemaName: sout.schemaName,
        data: sout.data,
        ...(sout.keyDecisions ? { keyDecisions: sout.keyDecisions } : {}),
      }),
    ),
  ]);

  const reportMarkdown =
    typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

  // Preserve everything else on lastOutput; only fill in artifact.report.
  const prevArtifact = state.lastOutput?.artifact ?? {};
  return {
    lastOutput: state.lastOutput
      ? {
          ...state.lastOutput,
          artifact: { ...prevArtifact, report: reportMarkdown },
        }
      : null,
  };
}
```

**Step 2: Run the test to verify it passes**

Run: `pnpm vitest run tests/orchestrator-report-writer.test.ts`
Expected: PASS — three tests green (null no-op, skip-schema no-op, render path)

**Step 3: Verify lint**

Run: `pnpm lint`
Expected: clean (apply `pnpm lint:fix` if biome formats anything)

**Step 4: Commit**

```bash
git add src/orchestrator/report-writer.ts tests/orchestrator-report-writer.test.ts
git commit -m "feat(report-writer): render boss-facing markdown for non-skip schemas

Calls a small Haiku model with a generic narrator system prompt and a
schema-aware user template. Output replaces only artifact.report; all
other lastOutput fields are preserved. Will be exercised once agents
start emitting structuredOutput in PR2 onwards — no agent does today,
so the rendering path is dead in production for this PR."
```

---

## Task 10: report-writer — failing test for error-handling fallback

**Files:**
- Modify: `tests/orchestrator-report-writer.test.ts`

**What:** When the LLM call throws, report-writer must NOT propagate the error. It must return a state patch with a fallback report and never crash the graph. Per design §6, this is critical: report-writer failures must never prevent task delivery.

**Step 1: Add the failing test**

```ts
describe('runReportWriter — error handling', () => {
  it('returns a fallback report and does not throw when the LLM rejects', async () => {
    invokeMock.mockRejectedValueOnce(new Error('LLM provider 503'));

    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [new HumanMessage('幫我寫一篇文章')],
      params: {},
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: {
        agentId: 'article-writer',
        message: 'draft done',
        artifact: { body: '# article', refs: {} },
      },
      lastStructuredOutput: {
        agentId: 'article-writer',
        schemaName: 'article-draft',
        data: { title: 'X' },
      },
      awaitingApproval: true,
      currentTaskOutput: null,
      taskImageIds: null,
    };

    // Must not throw.
    const result = await runReportWriter(state);

    expect(result.lastOutput?.artifact?.report).toBeTruthy();
    expect(result.lastOutput?.artifact?.report).toContain('匯報生成失敗');
    // Body must still be preserved.
    expect(result.lastOutput?.artifact?.body).toBe('# article');
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/orchestrator-report-writer.test.ts`
Expected: FAIL — current implementation throws (the rejected promise propagates out of `model.invoke`)

**Step 3: (no commit — implement next)**

---

## Task 11: report-writer — implement error-handling fallback

**Files:**
- Modify: `src/orchestrator/report-writer.ts`

**What:** Wrap the LLM call in try/catch. On error, log a warning and write a short fallback markdown to `artifact.report` so the boss sees *something*. Use `logger` from `lib/logger.js` for the warn — same pattern other nodes use.

**Step 1: Edit report-writer.ts**

Add the import:

```ts
import { logger } from '../lib/logger.js';
```

Wrap the LLM invoke + content extraction in try/catch:

```ts
  let reportMarkdown: string;
  try {
    const model = buildModel(REPORT_MODEL);
    const response = await model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        buildUserPrompt({
          brief,
          agentId: sout.agentId,
          schemaName: sout.schemaName,
          data: sout.data,
          ...(sout.keyDecisions ? { keyDecisions: sout.keyDecisions } : {}),
        }),
      ),
    ]);
    reportMarkdown =
      typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  } catch (err) {
    // Report-writer failures must never block task delivery. Log warn,
    // write a short fallback so the boss isn't left staring at a missing
    // section, and let the graph continue to END.
    logger.warn(
      { err, taskId: state.taskId, agentId: sout.agentId, schemaName: sout.schemaName },
      'report-writer LLM call failed — using fallback prose',
    );
    reportMarkdown =
      '> ⚠️ 匯報生成失敗。請直接看下方 artifact 內容，或重新觸發 task。';
  }
```

(Place the existing `prevArtifact` / `return` lines unchanged after this block.)

**Step 2: Run the tests**

Run: `pnpm vitest run tests/orchestrator-report-writer.test.ts`
Expected: PASS — all four tests green

**Step 3: Commit**

```bash
git add src/orchestrator/report-writer.ts tests/orchestrator-report-writer.test.ts
git commit -m "feat(report-writer): silent-degrade fallback when the LLM rejects

Report-writer must never block task delivery — it's a presentation
layer, not the source of truth. On LLM failure, log a warn (with task
+ agent + schema for triage) and write a one-line fallback so the
boss sees the artifact panel anyway."
```

---

## Task 12: Wire `report-writer` into the graph

**Files:**
- Modify: `src/orchestrator/graph.ts:46` (StateGraph construction), `:132-140` (edges)

**What:** Add `report-writer` as a node and rewire the supervisor's conditional edge so terminal paths (`awaitingApproval` or `!nextAgent`) flow through `report-writer` before `END`. This is the only change in this task; the per-agent edges back to supervisor are unchanged.

**Step 1: Edit graph.ts**

Add the import at the top:

```ts
import { runReportWriter } from './report-writer.js';
```

In `buildGraph`, change the StateGraph construction. Currently:

```ts
const graph = new StateGraph(GraphStateAnnotation).addNode('supervisor', runSupervisor);
```

Change to:

```ts
const graph = new StateGraph(GraphStateAnnotation)
  .addNode('supervisor', runSupervisor)
  .addNode('report-writer', runReportWriter);
```

Then change the conditional edge + terminal wiring. Currently:

```ts
graph.addEdge(START, 'supervisor').addConditionalEdges('supervisor', (state: GraphState) => {
  if (state.awaitingApproval) return END;
  if (!state.nextAgent) return END;
  return state.nextAgent;
});

for (const agent of agents) {
  graph.addEdge(agent.manifest.id as never, 'supervisor' as never);
}
```

Change to:

```ts
graph.addEdge(START, 'supervisor').addConditionalEdges('supervisor', (state: GraphState) => {
  // Terminal paths route through report-writer so the boss-facing prose
  // gets rendered before the graph ends. Mid-flow hops bypass it
  // entirely — only HITL boundaries and natural completion pay the cost.
  if (state.awaitingApproval) return 'report-writer';
  if (!state.nextAgent) return 'report-writer';
  return state.nextAgent;
});

graph.addEdge('report-writer' as never, END as never);

for (const agent of agents) {
  graph.addEdge(agent.manifest.id as never, 'supervisor' as never);
}
```

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: clean

**Step 3: Run the full unit test suite**

Run: `pnpm test`
Expected: all unit tests green (194+). report-writer is now in every graph but no agent emits `structuredOutput`, so its no-op path runs every terminal hop with zero observable effect.

**Step 4: Commit**

```bash
git add src/orchestrator/graph.ts
git commit -m "feat(graph): wire report-writer between supervisor and END

Supervisor's terminal conditional now routes to 'report-writer' instead
of END; report-writer → END closes the loop. Mid-flow hops (agent →
supervisor → next agent) skip the new node entirely. No agent emits
structuredOutput in this PR, so report-writer no-ops every time and
production behavior is identical."
```

---

## Task 13: Integration test — graph routes through report-writer at HITL boundary

**Files:**
- Create: `tests/integration/report-writer-wiring.test.ts`

**What:** End-to-end check that confirms (a) when an existing agent (without `structuredOutput`) finishes and signals `awaitingApproval`, the graph still completes successfully, and (b) `task.output` shape is identical to before this PR. This is the regression net for "zero behavior change".

**Step 1: Write the integration test**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import { scriptStructured, scriptToolCall } from './helpers/llm-mock.js';

const { createTestApp } = await import('./helpers/app.js');
const { drainNextTask } = await import('./helpers/worker.js');
const { getTask } = await import('../../src/tasks/repository.js');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll();
  fetchMock.mockReset();
});

describe('report-writer wiring — zero behavior change for un-migrated agents', () => {
  it('an agent that does not emit structuredOutput still completes a HITL pause cleanly', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });

    // shopify-blog-writer (current, un-migrated) doesn't set structuredOutput.
    // It produces an article via submit_article — exactly as before this PR.
    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptToolCall('submit_article', {
      title: 'Pre-refactor article',
      slug: 'pre-refactor-article',
      body: '## Body\n\nLong enough to satisfy the schema minimum body length for an SEO article.',
      summaryHtml: 'A summary that gives enough length for the schema minimum.',
      tags: ['demo'],
      language: 'en',
      report: '## Decision\n\nThis report comes from the agent itself, not the new report-writer.',
      progressNote: 'Draft done.',
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'pre-refactor regression check' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    const task = await getTask(tenantId, taskId);
    // Critical invariants for "zero behavior change":
    //   - task reaches waiting (HITL gate fired correctly)
    //   - artifact.report is the agent's own output (NOT overwritten by report-writer)
    //   - task.output.lastStructuredOutput is absent (the agent didn't emit it)
    expect(task.status).toBe('waiting');
    const output = task.output as Record<string, unknown> | null;
    expect((output?.artifact as { report?: string } | undefined)?.report).toContain(
      'This report comes from the agent itself',
    );
    expect(output).not.toHaveProperty('lastStructuredOutput');
  });
});
```

**Step 2: Verify the test scaffolding helpers exist**

Run: `ls tests/integration/helpers/`
Expected: `app.ts`, `auth.ts`, `db.ts`, `llm-mock.ts`, `worker.ts` (or similar)

If any helper doesn't exist with the expected export shape, look at how `tests/integration/shopify-blog-writer.test.ts` imports them and copy that pattern. Adjust imports if names differ.

**Step 3: Run the integration test**

Run: `pnpm vitest run --config vitest.integration.config.ts tests/integration/report-writer-wiring.test.ts`
Expected: PASS

**Step 4: Run all integration tests to confirm nothing else regressed**

Run: `pnpm test:integration`
Expected: all integration tests green

**Step 5: Commit**

```bash
git add tests/integration/report-writer-wiring.test.ts
git commit -m "test(integration): regression net for report-writer zero-behavior-change

Locks in the property PR1 promises: when an agent doesn't emit
structuredOutput (every agent today), the new report-writer node
no-ops, the agent's own artifact.report survives intact, and
task.output.lastStructuredOutput is absent. PR2 onwards will
add positive tests for the rendered path."
```

---

## Task 14: Final verification

**Files:** None modified.

**What:** Run everything end-to-end and confirm baseline parity.

**Step 1: Full pipeline**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
```

Expected:
- typecheck: clean
- lint: clean
- unit tests: 194 + 4 new (report-writer) = 198 passed
- integration tests: previous count + 1 new (regression net) all passed

If any test fails, do not proceed — investigate. The promise of PR1 is byte-for-byte identical observable behavior; any test failure means the implementation drifted from that promise.

**Step 2: Manually inspect a task end-to-end (sanity check)**

```bash
supabase status   # confirm local Supabase is running
pnpm dev          # in another shell
```

Open http://127.0.0.1:8080/docs and trigger a `POST /v1/tasks` with a simple brief. Watch the logs — `report-writer` should log nothing (it's silent on no-op). Confirm `task.output.artifact.report` content matches what the old shopify-blog-writer would have produced.

**Step 3: Update the PR description / commit log** *(if landing as a single PR)*

If this is going up as a single PR (recommended), the commits made along the way already form the PR's narrative. Tag the PR with `feat(graph)` and link the design doc:

> Implements PR1 of `docs/plans/2026-05-07-graph-refactor-design.md` — adds the `report-writer` node and `lastStructuredOutput` channel as dead infrastructure. Production behavior is unchanged because no agent emits `structuredOutput` yet; PR2 will land the first agent that does (`article-writer` after the EEAT split).

**Step 4: Hand back to brainstorming for PR2 plan when ready**

Don't start PR2 in this plan — write a separate `2026-05-07-graph-refactor-pr2-impl.md` (or whichever date) so each PR has a focused, reviewable plan.

---

## What's NOT in this PR (for clarity)

- No agent changes
- No EEAT split
- No workflow sub-graph
- No `pinnedAgent` resume short-circuit changes
- No persistence schema migration
- No supervisor prompt changes
- No `task.output.artifact.report` consumer changes (UI / email / `/continue` all see the same data they always did)

These all land in subsequent PRs per the design doc's PR sequence.
