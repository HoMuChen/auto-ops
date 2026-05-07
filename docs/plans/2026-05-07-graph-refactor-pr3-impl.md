# Graph Refactor PR3: Migrate `market-researcher` — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the `market-researcher` atomic agent to the PR1 `lastStructuredOutput` channel — drop the `report` field from its submit schema, add `keyDecisions[]`, and stop writing `artifact.report` so the shared `report-writer` node renders the boss-facing prose instead.

**Architecture:**
- Agent submit schema renames `report` → `body` (the raw markdown deliverable) and adds `keyDecisions[]` (3–5 bullets the report-writer reads to choose what to emphasize).
- `invoke()` returns `artifact.body` + `artifact.refs` (sources stay) and a `structuredOutput` block with `schemaName='market-report'`. **No `artifact.report`** — report-writer fills it post-supervisor.
- `manifest.metadata` gets `{ kind: 'execution', shape: 'atomic' }` for symmetry with `article-writer` / `eeat-interviewer` (PR2).
- Pure additive change to behaviour: nothing about routing, tools, gating, or HITL semantics moves. Mid-migration coexistence with not-yet-migrated agents (product-planner, seo-strategist, etc.) keeps working because PR1's report-writer no-ops on `lastStructuredOutput=null`.

**Tech Stack:** TypeScript, Zod, vitest. House LLM gateway is OpenRouter via `buildModel()`. Test style: `vi.mock` for the unit test; real Supabase + `llm-mock` (`scriptStructured` + `scriptToolCall` + `scriptText`) for the new integration test.

**Design ref:** `docs/plans/2026-05-07-graph-refactor-design.md` §"PR3–7", §"`report-writer` node", §"`IAgent` contract changes".

---

## Pre-flight

```bash
pnpm typecheck             # expect: clean
pnpm lint                  # expect: clean
pnpm test                  # expect: 205 passed (PR1 + PR2 baseline)
pnpm test:integration      # expect: 103 passed
```

If baseline isn't green, stop — we land on a clean main or not at all.

**Worktree setup:** Use `superpowers:using-git-worktrees` to create `.worktrees/graph-refactor-pr3` on branch `feat/graph-refactor-pr3`. Copy `.env` from the primary worktree (`cp /Users/largitdata/project/auto-ops/.env .env`) so integration tests can resolve `DATABASE_URL`.

**Scope sanity check (run from worktree):**

```bash
grep -rn "market-researcher\|marketResearcher" src/ tests/ --include="*.ts"
```

Expected matches (if anything else turns up, stop and re-scope before starting):
- `src/agents/builtin/market-researcher/index.ts` — the agent itself
- `src/agents/index.ts` — bootstrap registration (no change needed, id stays the same)
- `tests/market-researcher.test.ts` — unit test (rewriting in Task 1/2)
- `tests/supervisor.test.ts:213, 236, 248` — uses the string id `'market-researcher'` only as a fixture for an unrelated supervisor-prompt assertion. **Do not touch.**

No integration test currently references `market-researcher` (we add one in Task 4).

---

## Phase A — Migrate the agent (TDD, single commit)

### Task 1: Rewrite the unit test to assert the new shape (RED)

**Files:**
- Modify: `tests/market-researcher.test.ts` (full rewrite — fixture + 4 specs)

**What:** The existing test asserts `result.artifact.report` and a fixture field named `report`. Both go away. After this task the file compiles but the suite fails — that's the RED state we want before changing the agent in Task 2.

**Step 1: Replace the file with the new spec set**

```ts
// tests/market-researcher.test.ts
import { describe, expect, it, vi } from 'vitest';

/**
 * Market Researcher (post-PR3): produces a structured market report. The
 * agent emits `artifact.body` + `artifact.refs` + `structuredOutput`
 * (schemaName='market-report'); the shared report-writer node renders
 * `artifact.report` from `lastStructuredOutput` at the HITL boundary, so
 * the agent itself no longer writes `artifact.report`.
 */

const reportFixture = {
  body: `## 市場概況

寵物用品市場規模約新台幣 350 億，年成長 6%（2024 → 2026）。
地理上以雙北、桃園消費密度最高，南部以台中、高雄為次集中區，
線上滲透率 32%。整體呈現高端鮮食 + 中低價乾糧兩極分化。

## 主要競品

- **A 牌**：中價位主食罐主導，主打成分透明，無補貼貨架但社群弱。
- **B 牌**：低價乾糧，超市通路強，網購弱，價格戰主軸。
- **C 牌**：高價手作鮮食，社群經營佳但物流痛點明顯，常被抱怨配送破損。
- **D 牌**：訂閱模型 (subscribe & save)，自動續約 + 會員價，高黏著但 SKU 少。

## 市場缺口

中價位且具設計感的訂閱式鮮食方案，目前明顯空白。
中型犬齡 7+ 的關節保健食品線，本土品牌幾乎沒人做，依賴進口品。

## 消費者趨勢

養寵物高齡化（飼主平均 38 歲，寵物平均 6.2 歲），
飼主開始重視關節與心血管保健配方。社群上「人寵共食」標籤年增 180%。

## 切入建議

1. 中價位訂閱鮮食 + 機能配方為主打，避開最內卷的 100-300 元乾糧紅海。
2. 雙北通路採實體品牌快閃 + 線上會員雙軌，跨足社群 KOC 行銷。
3. SKU 聚焦 8-12 項，做深不做廣，前 6 個月不擴品類。`,
  sources: ['https://example.com/pet-market-2026', 'https://example.com/competitor-c-review'],
  keyDecisions: [
    '聚焦中價位設計感缺口，避開低價乾糧紅海',
    'D 牌訂閱模型雖強但 SKU 少，可從品項深度切入',
    '高齡寵物關節保健是本土品牌空白',
  ],
  progressNote: '報告好了，這個品類最大缺口是中價位設計感商品，老闆看一下切入建議',
};

const toolPassInvokeMock = vi.fn();
toolPassInvokeMock.mockResolvedValue({
  content: '',
  tool_calls: [{ id: 'call_submit_1', name: 'submit_report', args: reportFixture }],
});
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
  })),
}));

const { marketResearcherAgent } = await import('../src/agents/builtin/market-researcher/index.js');

describe('marketResearcherAgent.build → invoke', () => {
  const ctx = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: marketResearcherAgent.manifest.defaultModel,
    systemPrompt: marketResearcherAgent.manifest.defaultPrompt,
    agentConfig: {},
    availableExecutionAgents: [],
    tenantProfile: {
      profileMd: '',
      timezone: 'UTC',
      imageStyleSuffix: '',
      imageStyleReferenceImageIds: [],
    },
    logCtx: {
      taskId: '00000000-0000-0000-0000-000000000002',
      agentId: 'market-researcher',
    },
    emitLog: vi.fn(async (_event: string, _message: string, _data?: Record<string, unknown>) => {}),
  };

  it('emits artifact.body + refs.sources and gates on approval (no artifact.report)', async () => {
    const runnable = await marketResearcherAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: '幫我研究寵物用品在台灣的市場' }],
      params: {},
    });

    expect(result.awaitingApproval).toBe(true);
    expect(result.spawnTasks).toBeUndefined();
    expect(result.pendingToolCall).toBeUndefined();
    // The agent no longer writes report — that's report-writer's job now.
    expect(result.artifact?.report).toBeUndefined();
    expect(result.artifact?.body).toContain('## 市場概況');
    expect(result.artifact?.body).toContain('## 切入建議');
    expect(result.artifact?.refs).toEqual({
      sources: reportFixture.sources,
      sourceCount: 2,
    });
  });

  it('surfaces structuredOutput on the inter-node bus for report-writer', async () => {
    const runnable = await marketResearcherAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: '幫我研究寵物用品在台灣的市場' }],
      params: {},
    });

    expect(result.structuredOutput?.schemaName).toBe('market-report');
    expect(result.structuredOutput?.data).toMatchObject({
      body: expect.stringContaining('## 市場概況'),
      sources: reportFixture.sources,
    });
    expect(result.structuredOutput?.keyDecisions).toEqual(reportFixture.keyDecisions);
  });

  it('uses the LLM-produced progressNote as the agent.report.ready timeline message', async () => {
    const emitLog = vi.fn(
      async (_event: string, _message: string, _data?: Record<string, unknown>) => {},
    );
    const runnable = await marketResearcherAgent.build({ ...ctx, emitLog });
    await runnable.invoke({
      messages: [{ role: 'user', content: '研究' }],
      params: {},
    });

    const readyCall = emitLog.mock.calls.find((c) => c[0] === 'agent.report.ready');
    expect(readyCall?.[1]).toBe(reportFixture.progressNote);
  });

  it('contributes no tools — researcher is read-only and never gates on a write', async () => {
    const runnable = await marketResearcherAgent.build(ctx);
    expect(runnable.tools).toEqual([]);
  });

  it('honours configured defaultLanguage and searchLocale via tenant constraints', async () => {
    const runnable = await marketResearcherAgent.build({
      ...ctx,
      agentConfig: { defaultLanguage: 'en', searchLocale: 'us' },
    });
    await runnable.invoke({
      messages: [{ role: 'user', content: 'research US pet market' }],
      params: {},
    });
    const calls = toolPassInvokeMock.mock.calls as unknown as Array<Array<unknown>>;
    const lastCall = calls[calls.length - 1];
    const lastCallArgs = lastCall?.[0] as { content?: string }[] | undefined;
    const systemMsg = lastCallArgs?.find((m) => 'content' in m);
    const text = JSON.stringify(systemMsg);
    expect(text).toContain('Output language: en');
    expect(text).toContain('Default search locale: us');
  });
});
```

**Step 2: Run the suite and verify it fails for the RIGHT reasons**

```bash
pnpm test -- tests/market-researcher.test.ts
```

Expected failures (this is RED):
- `emits artifact.body + refs.sources …` — current agent writes `artifact.report`, not `artifact.body`. The fixture also no longer carries `report`, so the LLM-mock returns `args` without `report` — current Zod schema requires it, so the agent throws inside `runToolLoop`.
- `surfaces structuredOutput …` — current agent doesn't return `structuredOutput`.
- progressNote test will fail or pass depending on whether the schema rejection happens before the log call.

Acceptable failure messages contain any of: `artifact.body`, `structuredOutput`, schema validation `report`, `keyDecisions`. If the failures look unrelated (e.g. import error), stop and reconcile.

**Step 3: Do NOT commit yet — RED commit isn't part of this plan; we stage in Task 3 alongside the GREEN code.**

---

### Task 2: Migrate the agent to the new shape (GREEN)

**Files:**
- Modify: `src/agents/builtin/market-researcher/index.ts` (full rewrite of schema + invoke + manifest.metadata)

**What:** Three coordinated edits in one file:
1. **Schema:** rename `report` → `body`; add `keyDecisions: z.array(z.string().min(5)).min(1).max(5)`.
2. **`invoke`:** drop `artifact.report`, write `artifact.body`, add `structuredOutput` block.
3. **Manifest:** add `metadata: { kind: 'execution', shape: 'atomic' }` for symmetry with PR2 agents.

**Step 1: Replace the file**

```ts
// src/agents/builtin/market-researcher/index.ts
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
import { WebFetchClient } from '../../../integrations/web/client.js';
import { buildWebFetchTools } from '../../../integrations/web/tools.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { runToolLoop } from '../../lib/tool-loop.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';

const DEFAULT_PROMPT = `You are a Market Researcher AI employee for an e-commerce business.
Your job: produce ONE comprehensive market research report from the user's brief
and return it as the structured object requested. The report is the deliverable —
the user reviews it and either approves (task done) or asks for refinements.

Research workflow (search-then-read):
1. Call serper_search 2-4 times from different angles to map the landscape.
   Examples: "<category> 競爭", "<category> 市場規模", "<category> 痛點",
   "<category> 趨勢", "<category> 評論". Different queries surface different
   results — don't waste searches on minor variants of the same phrase.
2. From the SERP results, pick 3-6 of the most relevant URLs and call web_fetch
   on each to read the full content. Focus on: industry analyses, comparison
   reviews, top competitor product pages, news/feature articles. Do NOT fetch
   every result — each fetch costs latency and tokens. Skip thin pages
   (listings, splash homepages without analysis).
3. Synthesize. Cross-reference what multiple sources say. Cite specifics
   (pricing, feature names, review themes) from the fetched content, not from
   snippets alone. Note where sources disagree.

Report structure (the markdown body in the \`body\` field):
- ## 市場概況 — size, growth, geography, time-frame
- ## 主要競品 — 3-8 competitors with positioning, pricing tier, key strengths/weaknesses
- ## 市場缺口 — observed unmet needs, underserved segments, weak product-market fit
- ## 消費者趨勢 — emerging behaviors, demand shifts, social signals
- ## 切入建議 — concrete strategic recommendations, ranked by feasibility

Tone: like an analyst writing a memo to the boss. Use the language specified
in tenant constraints (default zh-TW). Length: 600-2000 words in target
language. Avoid filler. Cite findings inline like (來源: example.com).
List every URL you fetched (and any other URL you cite) in the \`sources\`
field — the framework renders the source list separately.

progressNote is one short sentence for the kanban timeline. keyDecisions is
3-5 short bullets the report-writer can lean on; the boss-facing prose is
rendered by a separate report-writer node, so do NOT write your own boss
memo here.

Submit the final report via submit_report when ready.`;

const configSchema = z
  .object({
    defaultLanguage: z
      .enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
      .default('zh-TW')
      .describe('Output language for the report when the brief does not specify.'),
    searchLocale: z
      .string()
      .default('tw')
      .describe(
        'Default Serper search locale (geo), e.g. "tw", "us", "jp". The agent may override per-query.',
      ),
  })
  .default({});

type MarketResearcherConfig = z.infer<typeof configSchema>;

const ReportSchema = z.object({
  body: z
    .string()
    .min(300)
    .max(8000)
    .describe(
      'Full market research report in Markdown. Sections: ## 市場概況 / ## 主要競品 / ## 市場缺口 / ## 消費者趨勢 / ## 切入建議. ' +
        '600-2000 words in the target language. Cite sources inline like (來源: example.com).',
    ),
  sources: z
    .array(z.string().url())
    .max(30)
    .describe(
      'Every URL you cited or fetched. The framework renders this as the sources panel; do NOT also list URLs in the report body to avoid duplication.',
    ),
  keyDecisions: z
    .array(z.string().min(5))
    .min(1)
    .max(5)
    .describe(
      '3-5 short bullets the downstream report-writer can lean on when generating boss prose. ' +
        'Examples: "聚焦中價位設計感缺口", "競品 D 牌 SKU 太少不算威脅". ' +
        'Be concrete about market gaps, competitor reads, and recommended angle. Not boss-facing prose itself.',
    ),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe(
      '一句話對老闆回報這份研究的重點或意外發現。' +
        '例：「報告好了，這個品類最大缺口是中價位的設計感商品，老闆看一下切入建議」。' +
        '用 zh-TW 第一人稱，對話對象是「老闆」，不要寫成翻譯腔。',
    ),
});

export const marketResearcherAgent: IAgent = {
  manifest: {
    id: 'market-researcher',
    name: '市場研究員',
    description:
      '市場研究的入口；產出一份結構化 markdown 研究報告，' +
      '透過 serper 搜尋 + web 讀取競品/分析文章，' +
      '輸出市場概況、競品、缺口、趨勢、切入建議。不寫文章、不上架。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.3 },
    defaultPrompt: DEFAULT_PROMPT,
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'execution', shape: 'atomic' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as MarketResearcherConfig;

    const serperKey = env.SERPER_API_KEY;
    const serperTools = serperKey
      ? buildSerperTools({
          tenantId: ctx.tenantId,
          cache: new SerpCache(new SerperClient({ apiKey: serperKey })),
        })
      : [];
    const webFetchTools = buildWebFetchTools({ client: new WebFetchClient() });

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', '開始研究市場，給我幾分鐘', {
        searchAvailable: serperTools.length > 0,
      });

      const constraints: string[] = [
        `Output language: ${cfg.defaultLanguage}`,
        `Default search locale: ${cfg.searchLocale}`,
      ];

      const messages = await buildAgentMessages(
        ctx.systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );

      // Researcher needs more research budget than writer: 2-4 searches +
      // 3-6 fetches + 1 submit ≈ 6-11 hops. maxHops 14 leaves headroom for
      // the model to follow up on a surprising finding without exhausting.
      const result = await runToolLoop({
        modelConfig: ctx.modelConfig,
        messages,
        tools: [...serperTools, ...webFetchTools],
        maxHops: 14,
        emitLog: ctx.emitLog,
        logCtx: ctx.logCtx,
        finalAnswer: {
          schema: ReportSchema,
          name: 'submit_report',
          description:
            'Call this exactly once when your research is complete. The args ARE the final research report shown to the user for approval.',
          // Force at least one search hop when serper is available — a
          // training-data-only "research" report is the failure mode.
          minToolHops: serperTools.length > 0 ? 1 : 0,
        },
      });

      if (result.kind !== 'submitted') {
        throw new Error(
          'Market Researcher did not submit a report within the tool loop budget — model emitted free-form content without calling submit_report.',
        );
      }
      const report = result.value;

      await ctx.emitLog('agent.report.ready', report.progressNote, {
        artifactShape: 'body+structuredOutput',
        sourceCount: report.sources.length,
        bodyLength: report.body.length,
      });

      // NOTE: artifact.report intentionally absent — the shared report-writer
      // node fills it from state.lastStructuredOutput at the HITL boundary.
      return {
        message: report.progressNote,
        awaitingApproval: true,
        artifact: {
          body: report.body,
          refs: { sources: report.sources, sourceCount: report.sources.length },
        },
        structuredOutput: {
          schemaName: 'market-report',
          data: {
            body: report.body,
            sources: report.sources,
          },
          keyDecisions: report.keyDecisions,
        },
      };
    };

    return { tools: [], invoke };
  },
};
```

**Step 2: Re-run the unit test — expect GREEN**

```bash
pnpm test -- tests/market-researcher.test.ts
```

Expected: all 5 specs pass. If the `structuredOutput` spec fails on `data.body`, double-check you didn't accidentally drop it from the `data` object.

**Step 3: Run the full unit suite to catch ripple-effect breakage**

```bash
pnpm test
```

Expected: 205 passing (no regression). The supervisor.test.ts assertion `'market-researcher: 已產出市場研究報告'` is unrelated to the agent's internals and continues to pass.

---

### Task 3: Typecheck, lint, commit

**Step 1: Typecheck**

```bash
pnpm typecheck
```

Expected: clean. If anything in `src/orchestrator/graph.ts` or `src/tasks/runner.ts` complains about `structuredOutput`/`lastStructuredOutput`, you've drifted from the PR1 contract — re-read `src/agents/types.ts` for the `AgentOutput.structuredOutput` shape.

**Step 2: Lint**

```bash
pnpm lint
```

Expected: clean. If formatting nits, run `pnpm lint:fix` and re-stage.

**Step 3: Commit (single commit — schema + invoke + test together)**

```bash
git add src/agents/builtin/market-researcher/index.ts tests/market-researcher.test.ts
git commit -m "$(cat <<'EOF'
feat(market-researcher): emit structuredOutput; report-writer renders prose

- Schema: rename `report` field to `body`; add `keyDecisions[]`.
- Invoke: drop `artifact.report`; emit `artifact.body` + `structuredOutput`
  with `schemaName='market-report'` so the shared report-writer node
  (PR1) renders the boss-facing prose at the HITL boundary.
- Manifest: tag as `{ kind: 'execution', shape: 'atomic' }` for symmetry
  with the PR2-migrated atomic agents (article-writer, eeat-interviewer).
- Unit test: rewrite fixture (`body` not `report`, plus `keyDecisions`);
  add a spec asserting the structuredOutput bus payload.

PR3 of the graph-refactor migration. Mid-migration coexistence holds:
agents not yet migrated (product-planner, seo-strategist, etc.) keep
writing `artifact.report` themselves and report-writer no-ops on them
because their `lastStructuredOutput` stays null.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Live-wire integration test

### Task 4: New integration test — full graph, real Supabase, mocked LLM

**Files:**
- Create: `tests/integration/market-researcher.test.ts`

**What:** Mirror `tests/integration/article-writer.test.ts` so we verify the **end-to-end live wiring**:
- Supervisor routes the brief to `market-researcher`.
- The agent submits the report (mocked tool call).
- Report-writer is invoked (mocked text response) and writes `artifact.report`.
- `task.output.lastStructuredOutput` is persisted with `schemaName='market-report'`.
- `task.output.artifact.body` carries the raw markdown; `task.output.artifact.report` carries the **rendered prose** (NOT a verbatim copy of body).
- Task ends in `done` (no pendingToolCall — research is plain-text deliverable).

**Step 1: Create the file**

```ts
// tests/integration/market-researcher.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import {
  clearScript,
  llmMockModule,
  scriptStructured,
  scriptText,
  scriptToolCall,
} from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

const { createTestApp } = await import('./helpers/app.js');
const { getTask } = await import('../../src/tasks/repository.js');

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await truncateAll();
  clearScript();
});

describe('market-researcher atomic agent — direct routing + report-writer rendering', () => {
  it('researches → report-writer renders prose → done; structuredOutput persisted', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await app.inject({
      method: 'POST',
      url: '/v1/agents/market-researcher/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: {} },
    });

    // Hop 1: supervisor → market-researcher.
    scriptStructured({ nextAgent: 'market-researcher', clarification: null, done: false });

    // Hop 2: agent invokes its tool loop and submits the report.
    const reportBody = `## 市場概況

寵物用品市場約 350 億，年成長 6%，線上滲透率 32%。

## 主要競品

- A 牌：中價位主食罐，成分透明但社群弱。
- B 牌：低價乾糧，超市強網購弱。
- C 牌：高價手作鮮食，物流痛點明顯。

## 市場缺口

中價位且具設計感的訂閱式鮮食方案目前明顯空白。

## 消費者趨勢

養寵物高齡化，飼主開始重視關節保健配方。

## 切入建議

中價位訂閱鮮食 + 機能配方為主打，避開低價乾糧紅海。`;

    scriptToolCall('submit_report', {
      body: reportBody,
      sources: ['https://example.com/pet-market-2026', 'https://example.com/competitor-c-review'],
      keyDecisions: [
        '聚焦中價位設計感缺口',
        '避開低價乾糧紅海',
        '高齡寵物保健是空白市場',
      ],
      progressNote: '報告好了，最大缺口是中價位設計感商品，老闆看一下切入建議',
    });

    // Hop 3: supervisor decides the work is done — done=true so we route
    // through report-writer to END.
    scriptStructured({ nextAgent: null, clarification: null, done: true });

    // Hop 4: report-writer LLM call — renders boss prose for schemaName='market-report'.
    scriptText(
      '## 我看到的重點\n\n中價位設計感商品是這個品類最大的空白。\n\n## 為什麼這樣選\n\n低價乾糧已是紅海，高價手作有物流痛點。',
    );

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: '幫我研究台灣寵物用品市場' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    const task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('market-researcher');
    expect(task.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer, contains the prose it
        // generated — NOT a verbatim copy of structuredOutput.data.body.
        report: expect.stringContaining('我看到的重點'),
        body: expect.stringContaining('## 市場概況'),
        refs: expect.objectContaining({
          sources: expect.arrayContaining(['https://example.com/pet-market-2026']),
          sourceCount: 2,
        }),
      },
      lastStructuredOutput: {
        schemaName: 'market-report',
        data: expect.objectContaining({
          body: expect.stringContaining('## 市場概況'),
          sources: expect.arrayContaining(['https://example.com/pet-market-2026']),
        }),
        keyDecisions: expect.arrayContaining(['聚焦中價位設計感缺口']),
      },
    });
    // Researcher is plain-text deliverable — no pending tool call.
    expect(task.output).not.toHaveProperty('pendingToolCall');
  });
});
```

**Step 2: Run just this integration file**

```bash
pnpm test:integration -- tests/integration/market-researcher.test.ts
```

Expected: 1 passing.

Likely failure modes:
- **`task.assignedAgent` is null** — happens when `scriptStructured` hop 1 didn't fire because the supervisor hit a different code path. Re-read `tests/integration/helpers/llm-mock.ts` to confirm `scriptStructured` is queued FIFO and consumed by `withStructuredOutput().invoke()`.
- **`task.output.artifact.report` is undefined** — means report-writer didn't fire. Check that the `scriptStructured({ done: true })` hop is queued *before* the `scriptText(...)` hop; supervisor's terminal decision must precede the report-writer call.
- **`task.output.lastStructuredOutput` is missing** — graph.ts isn't surfacing it; verify `src/orchestrator/graph.ts:132-143` still spreads `lastStructuredOutput` when `result.structuredOutput` is set, and that `src/tasks/runner.ts:187-188` persists the channel into `task.output`.

**Step 3: Run the full integration suite to catch regressions**

```bash
pnpm test:integration
```

Expected: 104 passing (103 baseline + 1 new). Other agents stayed on `artifact.report` (they haven't migrated yet) so their tests stay green.

**Step 4: Commit**

```bash
git add tests/integration/market-researcher.test.ts
git commit -m "$(cat <<'EOF'
test(integration): market-researcher direct path + report-writer rendering

End-to-end verification that the migrated atomic agent flows through
supervisor → market-researcher → report-writer → END:
- structuredOutput (schemaName='market-report') is persisted to
  task.output.lastStructuredOutput.
- artifact.body carries the raw markdown deliverable.
- artifact.report carries the report-writer's rendered prose, NOT a
  verbatim copy of body.
- task ends in waiting (no pendingToolCall — research is plain-text).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Verify and finish

### Task 5: Full suite + finishing-a-development-branch

**Step 1: Final pre-merge verification**

Run all four checks from a clean shell in the worktree:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
```

Expected:
- typecheck: clean
- lint: clean
- unit: 205 passing (no count change — we replaced 4 specs with 5, but baseline was already 205 because PR2 added new specs in other files; `tests/market-researcher.test.ts` previously had 4 specs and now has 5, so total may increment to 206. Either is acceptable as long as **all** pass.)
- integration: 104 passing (103 baseline + 1 new)

If any number is short of the baseline above (excluding the +1 integration), stop and diagnose before finishing.

**Step 2: Hand off to finishing-a-development-branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."

**REQUIRED SUB-SKILL:** Use `superpowers:finishing-a-development-branch`. Present the 4 standard options. The expected user choice (matching PR1/PR2 cadence) is "Merge to main locally" — when chosen:
1. `git checkout main`
2. `git pull` (no-op if origin hasn't moved; PR2 isn't pushed yet so local main is already the source of truth)
3. `git merge feat/graph-refactor-pr3` (ff expected)
4. Re-run `pnpm test` on the merged main as a smoke check
5. `git branch -d feat/graph-refactor-pr3`
6. `git worktree remove .worktrees/graph-refactor-pr3`

**Do NOT push to origin without explicit user confirmation** — PR1 and PR2 both required the user to say "push it" before any push. Same convention here.

---

## Risks & mitigations

**R1 — Schema field rename breaks LLM behaviour**
The model has been seeing `report` in the schema. Now it sees `body` + `keyDecisions`. **Mitigation:** the system prompt explicitly references `body`; the schema descriptions are explicit; OpenRouter Sonnet 4.6 follows tool-schema names precisely. **Fallback:** unit test catches any regression because we mock the model entirely.

**R2 — Report-writer prose is bad-quality on the new schemaName**
Report-writer's user-prompt template is generic (no per-schema branch in `src/orchestrator/report-writer.ts`). For `'market-report'`, the generic prompt should be fine because `keyDecisions` carries the angle. **Mitigation:** if the rendered prose is consistently weak in real production runs, add a per-schema template entry to `REPORT_TEMPLATES` (designed for this in the original architecture doc but not yet wired). **Out of scope for this PR.**

**R3 — `task.output.artifact.body` consumers are surprised**
Today's API consumers may read `task.output.artifact.report` and not check `body`. **Mitigation:** report-writer fills `artifact.report` so the wire format still has it — consumers see *better* prose than before, not nothing. The `body` field is additive.

**R4 — Mid-migration assertion drift**
Other agents (product-planner, seo-strategist, product-designer, shopify-publisher) still write `artifact.report` themselves. PR1's null-check (`if (!sout) return {};`) means report-writer no-ops for them, so their existing prose is preserved. **No mitigation needed — designed for coexistence.**

**R5 — `Artifact.report` made optional in PR2; consumer types**
`src/tasks/artifact.ts` already types `report?: string` (PR2 made it optional). No type-level breakage expected. If something depends on `report` being non-null, surface it in Task 3's `pnpm typecheck`.

---

## Out of scope (deferred to later PRs)

- Per-schema `REPORT_TEMPLATES` entries — generic system prompt is sufficient for now (architecture doc §"`report-writer` node" describes the shape if/when needed).
- Migrating `product-planner` (PR4), `seo-strategist` (PR5), `product-designer` (PR6), `shopify-publisher` (PR7) — same recipe per PR.
- Pushing to `origin` — gated on explicit user confirmation per PR1/PR2 convention.
