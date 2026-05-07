# Graph Refactor PR4: Migrate `product-planner` — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the `product-planner` strategy agent to PR1's `lastStructuredOutput` channel — add `keyDecisions[]` to the schema, move the synthesized markdown deliverable from `artifact.report` to `artifact.body`, and emit `structuredOutput` with `schemaName='product-plan'` so the shared report-writer node renders the boss-facing prose at the HITL boundary.

**Architecture:**
- Schema: keep `overview`, `progressNote`, `variants` unchanged; add `keyDecisions[]` (3–5 short bullets the report-writer reads).
- `invoke()` keeps the existing synthesis (`overview + ### {variant.title}\n\n{variant.brief}` joined) but writes it to `artifact.body` (was `artifact.report`). Variants stay visible to the user via the same synthesis. Spawn-children plumbing (`spawnTasks` → `product-designer`) is unchanged.
- Emits `structuredOutput { schemaName: 'product-plan', data: { overview, variants }, keyDecisions }` on the inter-node bus. The data block carries everything the report-writer needs to mention strategy + variant counts in boss prose.
- `manifest.metadata` gains `shape: 'atomic'` alongside the existing `kind: 'strategy'` for symmetry with PR2/PR3-migrated agents.
- Mid-migration coexistence: `product-designer` and `shopify-publisher` (PR6/PR7) haven't migrated yet, so the E2E flow `planner → designer → publisher` keeps working — report-writer no-ops on them.

**Tech Stack:** TypeScript, Zod, vitest. House LLM gateway is OpenRouter via `buildModel()`. Test style: `vi.mock` for unit, real Supabase + `llm-mock` (`scriptStructured` + `scriptText` + `scriptToolCall`) for integration.

**Design ref:** `docs/plans/2026-05-07-graph-refactor-design.md` §"PR3–7", §"`report-writer` node", §"`IAgent` contract changes". Reference shape: PR3's `market-researcher` migration (`docs/plans/2026-05-07-graph-refactor-pr3-impl.md`); the synthesis-to-body twist is unique to this PR.

---

## Pre-flight

```bash
pnpm typecheck             # expect: clean
pnpm lint                  # expect: clean
pnpm test                  # expect: 206 passed (PR3 baseline)
pnpm test:integration      # expect: 104 passed
```

If baseline isn't green, stop — PR4 lands on a clean main or not at all.

**Worktree setup:** Use `superpowers:using-git-worktrees` to create `.worktrees/graph-refactor-pr4` on branch `feat/graph-refactor-pr4`. Copy `.env` from the primary worktree (`cp /Users/largitdata/project/auto-ops/.env .env`) so integration tests can resolve `DATABASE_URL`.

**Scope sanity check (run from the worktree):**

```bash
grep -rn "product-planner\|productPlanner\|PlanSchema" src/ tests/ --include="*.ts"
```

Expected matches (anything else surfaces, stop and re-scope):
- `src/agents/builtin/product-planner/index.ts` — the agent
- `src/agents/builtin/seo-strategist/index.ts` — also has a local `PlanSchema` symbol; **do not touch** (PR5)
- `src/agents/index.ts` — bootstrap registration (no change needed; id stays the same)
- `src/agents/lib/lenient-schemas.ts` — defines `flexibleDatetime` used by planner (no change)
- `tests/product-planner.test.ts` — unit test (rewriting in Task 1+2)
- `tests/product-designer.test.ts` — references planner's name in a comment only (no behavioural dep; **do not touch**)
- `tests/integration/setup.ts` — references the agent id as a string (no change)
- `tests/integration/product-publisher.test.ts` — E2E test that walks `planner → designer → publisher` (updating the planner phase in Task 4)

---

## Phase A — Migrate the agent (TDD, single commit)

### Task 1: Rewrite the unit test to assert the new shape (RED)

**Files:**
- Modify: `tests/product-planner.test.ts` (full rewrite — fixture + 4 specs)

**What:** The existing 3 specs assert `artifact.report` contains the synthesized markdown. After migration, `artifact.body` carries that synthesis and `artifact.report` will be filled by report-writer (which we don't trigger in unit tests because we mock the LLM at the `bindTools` boundary). One new spec covers the `structuredOutput` payload.

**Step 1: Replace the file**

```ts
import { describe, expect, it, vi } from 'vitest';

/**
 * product-planner (post-PR4): strategy agent that researches via Serper and
 * spawns product-designer tasks. The synthesized markdown deliverable now
 * lives on `artifact.body` (was `artifact.report`); `artifact.report` is
 * filled by the shared report-writer node downstream from
 * `structuredOutput.schemaName='product-plan'`. Spawn behaviour is unchanged.
 */

const planFixture = {
  reasoning: 'Two variants covering e-commerce and Instagram for the Taiwan market.',
  overview: `## 市場觀察

兩條主軸：機能透氣（通勤客）跟永續生活（自我認同消費者）。亞麻在台灣夏季 SERP 多半被「悶熱」「縮水」恐懼壟斷，反向操作 → 主打 180g 不悶 + 可機洗。

## 我的策略

兩個 variant：一個 zh-TW 電商頁面切「機能透氣」、一個 IG 社群版切「永續生活感」。`,
  progressNote: '研究完競品後規劃了 2 個 variants，老闆看一下',
  keyDecisions: [
    '兩條主軸：機能透氣 vs 永續生活感',
    '反向操作 SERP 的悶熱恐懼，主打 180g 不悶 + 可機洗',
    '電商版切實用、IG 版切價值觀，避免角度互相吃掉',
  ],
  variants: [
    {
      title: '亞麻短袖 - 電商版 (zh-TW)',
      platform: 'shopify',
      language: 'zh-TW',
      brief: `### Marketing angle
台灣濕熱夏天通勤族，怕熱怕悶；切「機能透氣」+ 在地實穿。

### Key messages
- 180g 亞麻不悶熱
- 台灣製造
- 可機洗、不縮水

### Copy brief
**Tone**: 自信、實用、台灣口語
**Features to highlight**: 透氣、台灣製、可機洗
**Forbidden claims**: "100% 不會皺"、誇張涼感字眼

### Image plan
- **Hero (required)**：模特在通勤情境中穿著、自然光
- **Detail (required)**：布料近拍、織紋、標籤
- **Lifestyle (optional)**：辦公室／咖啡店場景`,
      assignedAgent: 'product-designer',
    },
    {
      title: '亞麻短袖 - Instagram 版 (zh-TW)',
      platform: 'instagram',
      language: 'zh-TW',
      brief: `### Marketing angle
追求永續生活感的城市消費者；切「天然亞麻 + 少買好物」價值觀。

### Key messages
- 天然亞麻
- 少買好物

### Copy brief
**Tone**: 溫暖、生活感、安靜自信
**Features to highlight**: 天然材質、可長穿
**Forbidden claims**: "百分百環保"

### Image plan
- **Hero (required)**：折疊在木桌上、靜態靜物
- **Detail (optional)**：縫線特寫`,
      assignedAgent: 'product-designer',
    },
  ],
};

// Single-pass mock: model immediately submits the plan via submit_plan tool.
// runToolLoop intercepts, validates against PlanSchema, returns submitted.
const toolPassInvokeMock = vi.fn();
toolPassInvokeMock.mockResolvedValue({
  content: '',
  tool_calls: [{ id: 'call_submit_1', name: 'submit_plan', args: planFixture }],
});
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
  })),
}));

vi.mock('../src/integrations/serper/tools.js', () => ({
  SERPER_TOOL_IDS: ['serper.search'],
  buildSerperTools: vi.fn(() => [
    {
      id: 'serper.search',
      tool: {
        name: 'serper_search',
        invoke: vi.fn(async () => ({ organic: [], peopleAlsoAsk: [], relatedSearches: [] })),
      },
    },
  ]),
}));

vi.mock('../src/integrations/serper/cache.js', () => ({
  SerpCache: vi.fn(() => ({})),
}));

vi.mock('../src/integrations/serper/client.js', () => ({
  SerperClient: vi.fn(() => ({})),
}));

// Stub the tenant skill-packs DB query — agent .build() now calls loadPacks
// with ctx.tenantId, which would otherwise hit the real DB and ECONNREFUSED.
vi.mock('../src/agents/skill-packs-repository.js', () => ({
  listPacksForAgent: vi.fn(async () => []),
}));

const { productPlannerAgent } = await import('../src/agents/builtin/product-planner/index.js');

const designerPeer = {
  id: 'product-designer',
  name: 'Product Designer',
  description: 'Generates images and copy from a variant spec.',
};

describe('product-planner', () => {
  it('spawns one product-designer task per variant; synthesis lands on artifact.body', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'You are a product planner.',
      agentConfig: {},
      availableExecutionAgents: [designerPeer],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'product-planner' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'Plan content for this linen shirt' }],
      params: {},
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.spawnTasks).toHaveLength(2);
    expect(output.spawnTasks![0]!.assignedAgent).toBe('product-designer');
    expect(output.spawnTasks?.[0]?.input).toMatchObject({
      brief: expect.stringContaining('Marketing angle'),
      refs: { language: 'zh-TW' },
    });
    expect(output.spawnTasks?.[0]?.input).not.toHaveProperty('variantSpec');

    const artifact = output.artifact;
    expect(artifact).toBeDefined();
    // The agent no longer writes report — that's report-writer's job now.
    expect(artifact).not.toHaveProperty('report');
    expect(artifact).toHaveProperty('body');
    if (artifact && 'body' in artifact) {
      expect(artifact.body).toContain('## 市場觀察');
      expect(artifact.body).toContain('### 亞麻短袖 - 電商版 (zh-TW)');
      expect(artifact.body).toContain('### 亞麻短袖 - Instagram 版 (zh-TW)');
    }
  });

  it('surfaces structuredOutput on the inter-node bus for report-writer', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'You are a product planner.',
      agentConfig: {},
      availableExecutionAgents: [designerPeer],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'product-planner' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'Plan content for this linen shirt' }],
      params: {},
    });

    expect(output.structuredOutput?.schemaName).toBe('product-plan');
    expect(output.structuredOutput?.data).toMatchObject({
      overview: expect.stringContaining('## 市場觀察'),
      variants: expect.arrayContaining([
        expect.objectContaining({ title: '亞麻短袖 - 電商版 (zh-TW)' }),
      ]),
    });
    expect(output.structuredOutput?.keyDecisions).toEqual(planFixture.keyDecisions);
  });

  it('throws when no product-designer peer is available', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'sys',
      agentConfig: {},
      availableExecutionAgents: [],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'product-planner' },
      emitLog: vi.fn(async () => {}),
    });

    await expect(
      runnable.invoke({ messages: [{ role: 'user', content: 'brief' }], params: {} }),
    ).rejects.toThrow(/product-designer/i);
  });

  it('forwards originalImageIds to each spawned task', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-3',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'sys',
      agentConfig: {},
      availableExecutionAgents: [designerPeer],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-3', agentId: 'product-planner' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { imageIds: ['img-1', 'img-2'] },
    });

    expect(output.spawnTasks?.[0]?.input).toMatchObject({
      refs: { language: 'zh-TW', originalImageIds: ['img-1', 'img-2'] },
    });
    expect(output.spawnTasks?.[1]?.input).toMatchObject({
      refs: { language: 'zh-TW', originalImageIds: ['img-1', 'img-2'] },
    });
  });
});
```

**Step 2: Don't run the suite for RED** — we go straight to GREEN to keep the cycle short.

---

### Task 2: Migrate the agent (GREEN)

**Files:**
- Modify: `src/agents/builtin/product-planner/index.ts` (schema, invoke, manifest, prompt)

**What:** Five coordinated edits in one file:

1. **DEFAULT_PROMPT:** add a line about `keyDecisions` and remind the LLM not to write boss prose itself.
2. **`PlanSchema`:** add `keyDecisions: z.array(z.string().min(5)).min(1).max(5)`.
3. **`invoke()`:** rename the synthesized `report` local variable to `body`; return `artifact: { body }` instead of `{ report }`; add `structuredOutput` block.
4. **emitLog `agent.plan.ready` payload:** `artifactShape: 'body+structuredOutput'` (was `'report'`).
5. **Manifest:** `metadata: { kind: 'strategy', shape: 'atomic' }` (was `{ kind: 'strategy' }`).

**Step 1: Apply the prompt update at lines 22–69**

In the existing `DEFAULT_PROMPT` template, after the closing of "# Submitting your plan — the ONLY way to finish" section (right before "**Anti-patterns**"), add the new paragraph and update the field list:

Find the existing block:

```
When you have enough SERP context, **call the \`submit_plan\` tool**. The tool
arguments ARE your final deliverable: \`overview\` (zh-TW Markdown explaining
the overall strategy), \`progressNote\` (one-line status for the kanban),
and \`variants\` (the array of designer briefs). There is no other channel —
plain-text content you write does NOT reach the user.
```

Replace with:

```
When you have enough SERP context, **call the \`submit_plan\` tool**. The tool
arguments ARE your final deliverable: \`overview\` (zh-TW Markdown explaining
the overall strategy), \`progressNote\` (one-line status for the kanban),
\`keyDecisions\` (3-5 short bullets the report-writer can lean on when generating
boss-facing prose; these are NOT boss-facing prose themselves), and \`variants\`
(the array of designer briefs). There is no other channel — plain-text content
you write does NOT reach the user.

The boss-facing 匯報 (memo) is rendered by a separate report-writer node from
your structured output. Do NOT write a boss memo into \`overview\` — that field
is the strategy narrative for downstream consumers, not the executive summary.
```

**Step 2: Add `keyDecisions` to `PlanSchema` at line 100**

In `PlanSchema`, between `progressNote` and `variants`, add:

```ts
  keyDecisions: z
    .array(z.string().min(5))
    .min(1)
    .max(5)
    .describe(
      '3-5 short bullets the downstream report-writer can lean on when generating boss prose. ' +
        'Examples: "兩條主軸：機能透氣 vs 永續生活感", "反向操作 SERP 的悶熱恐懼，主打 180g 不悶 + 可機洗". ' +
        'Be concrete about strategic angles and trade-offs. Not boss-facing prose itself.',
    ),
```

After this edit, `PlanSchema` looks like:

```ts
const PlanSchema = z.object({
  overview: z.string().min(100).max(4000).describe(/* unchanged */),
  progressNote: z.string().min(10).max(200).describe(/* unchanged */),
  keyDecisions: z.array(z.string().min(5)).min(1).max(5).describe(/* see above */),
  variants: z.array(DesignerVariantSchema).min(1),
});
```

**Step 3: Update the manifest at line 137**

Change:

```ts
    metadata: { kind: 'strategy' },
```

To:

```ts
    metadata: { kind: 'strategy', shape: 'atomic' },
```

**Step 4: Update `invoke()` return shape at lines 241–256**

Find the existing block:

```ts
      await ctx.emitLog('agent.plan.ready', plan.progressNote, {
        artifactShape: 'report',
        variantCount: capped.length,
      });

      const report = [plan.overview, ...capped.map((v) => `### ${v.title}\n\n${v.brief}`)].join(
        '\n\n',
      );

      return {
        message: plan.progressNote,
        awaitingApproval: true,
        artifact: { report },
        spawnTasks,
      };
    };
```

Replace with:

```ts
      await ctx.emitLog('agent.plan.ready', plan.progressNote, {
        artifactShape: 'body+structuredOutput',
        variantCount: capped.length,
      });

      const body = [plan.overview, ...capped.map((v) => `### ${v.title}\n\n${v.brief}`)].join(
        '\n\n',
      );

      // NOTE: artifact.report intentionally absent — the shared report-writer
      // node fills it from state.lastStructuredOutput at the HITL boundary.
      return {
        message: plan.progressNote,
        awaitingApproval: true,
        artifact: { body },
        spawnTasks,
        structuredOutput: {
          schemaName: 'product-plan',
          data: {
            overview: plan.overview,
            variants: capped,
          },
          keyDecisions: plan.keyDecisions,
        },
      };
    };
```

**Step 5: Run the unit test for this file**

```bash
pnpm test -- tests/product-planner.test.ts
```

Expected: 4 specs passing. If the structuredOutput spec fails on `data.variants`, double-check you used `capped` (the post-`maxVariants` slice) rather than the raw `plan.variants`.

**Step 6: Run the full unit suite to catch ripple-effect breakage**

```bash
pnpm test
```

Expected: 207 passing (206 baseline + 1 new structuredOutput spec). The other product-planner specs (spawn-related) keep working.

---

### Task 3: Typecheck, lint, commit

**Step 1: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

**Step 2: Lint**

```bash
pnpm lint
```

Expected: clean. If formatting nits, run `pnpm lint:fix` and re-stage.

**Step 3: Commit (single commit — schema + invoke + test together)**

Stage exactly:
- `src/agents/builtin/product-planner/index.ts`
- `tests/product-planner.test.ts`

```bash
git add src/agents/builtin/product-planner/index.ts tests/product-planner.test.ts
git commit -m "$(cat <<'EOF'
feat(product-planner): emit structuredOutput; report-writer renders prose

- Schema: add `keyDecisions[]`. `overview` / `progressNote` / `variants`
  unchanged.
- Invoke: move the synthesized markdown deliverable from `artifact.report`
  to `artifact.body`; emit `structuredOutput` with `schemaName='product-plan'`
  so the shared report-writer node (PR1) renders the boss-facing prose at
  the HITL boundary. `spawnTasks` plumbing into `product-designer` is
  unchanged.
- Manifest: tag as `{ kind: 'strategy', shape: 'atomic' }` for symmetry
  with the PR2/PR3-migrated atomic agents.
- Prompt: explicitly tells the LLM not to write boss prose into `overview`
  (that's report-writer's job) and explains the new `keyDecisions` field.
- Unit test: rewrite fixture (`keyDecisions[]` added); the synthesis spec
  now asserts on `artifact.body` instead of `artifact.report`; new spec
  asserts the `structuredOutput` bus payload.

PR4 of the graph-refactor migration. Mid-migration coexistence holds:
the downstream `product-designer` and `shopify-publisher` haven't migrated
yet (PR6, PR7), so the E2E flow keeps working — they continue to write
their own `artifact.report` and report-writer no-ops on them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Update the E2E integration test

### Task 4: Update `tests/integration/product-publisher.test.ts` for the new planner shape

**Files:**
- Modify: `tests/integration/product-publisher.test.ts` (planner-phase script + assertions only; designer + publisher phases unchanged)

**What:** The E2E test walks `planner → designer → publisher`. After PR4, the planner phase fires one extra LLM call (report-writer's prose render) and surfaces `lastStructuredOutput` to `task.output`. The downstream phases are untouched (designer + publisher haven't migrated yet, so their report-writer hops still no-op).

Three small edits in the planner phase only:

1. Add `keyDecisions` to the `submit_plan` args.
2. Add `scriptText(...)` AFTER `scriptToolCall('submit_plan', ...)` to script the report-writer LLM call. **No extra `scriptStructured`** — supervisor short-circuits without an LLM call when `awaitingApproval=true` (verified in PR3 at `src/orchestrator/supervisor.ts:69-72`).
3. Extend the planner-phase assertions to cover `lastStructuredOutput` + the new `artifact.body`/`artifact.report` split.

**Step 1: Apply the planner-phase edits**

Find the block at lines 92–144 (Phase 1: planner runs):

```ts
    // ── Phase 1: product-planner runs ────────────────────────────────────────
    // Supervisor routes to product-planner (structured).
    scriptStructured({ nextAgent: 'product-planner', clarification: null, done: false });
    // Planner is single-pass now: tool-loop with finalAnswer:PlanSchema, model
    // submits via the submit_plan tool. No second structured-output round-trip.
    scriptToolCall('submit_plan', {
      reasoning: 'One Shopify variant for zh-TW e-commerce.',
      overview: `## 市場觀察

台灣夏季 SERP 對亞麻多半關注「悶熱」「縮水」恐懼，反向操作 → 主打 180g 不悶 + 可機洗。

## 我的策略

聚焦 1 個 variant：zh-TW 電商頁面，切「機能透氣」+ 在地實穿。`,
      progressNote: '規劃好了，1 個 variant，老闆看一下',
      variants: [
        {
          title: '亞麻短袖 - 電商版 (zh-TW)',
          platform: 'shopify',
          language: 'zh-TW',
          brief: `### Marketing angle
台灣濕熱夏天通勤族，怕熱怕悶；切「機能透氣」+ 在地實穿。

### Key messages
- 180g 亞麻不悶熱
- 可機洗

### Copy brief
**Tone**: warm, professional
**Features to highlight**: fabric weight, washability
**Forbidden claims**: 無

### Image plan
- **Hero (required)**：clean white background`,
          assignedAgent: 'product-designer',
        },
      ],
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'List this linen shirt for Taiwan market' },
    });
    expect(create.statusCode).toBe(201);
    const plannerTaskId = create.json().id as string;

    await drainNextTask();
    const plannerTask = await getTask(tenantId, plannerTaskId);
    expect(plannerTask.status).toBe('waiting');
    expect(plannerTask.kind).toBe('strategy');
    expect((plannerTask.output as { spawnTasks?: unknown[] })?.spawnTasks).toHaveLength(1);
```

Replace with:

```ts
    // ── Phase 1: product-planner runs ────────────────────────────────────────
    // Supervisor routes to product-planner (structured).
    scriptStructured({ nextAgent: 'product-planner', clarification: null, done: false });
    // Planner is single-pass now: tool-loop with finalAnswer:PlanSchema, model
    // submits via the submit_plan tool. No second structured-output round-trip.
    scriptToolCall('submit_plan', {
      reasoning: 'One Shopify variant for zh-TW e-commerce.',
      overview: `## 市場觀察

台灣夏季 SERP 對亞麻多半關注「悶熱」「縮水」恐懼，反向操作 → 主打 180g 不悶 + 可機洗。

## 我的策略

聚焦 1 個 variant：zh-TW 電商頁面，切「機能透氣」+ 在地實穿。`,
      progressNote: '規劃好了，1 個 variant，老闆看一下',
      keyDecisions: [
        '反向操作 SERP 悶熱恐懼，主打 180g 不悶',
        '聚焦 1 個 zh-TW 電商 variant 切機能透氣',
      ],
      variants: [
        {
          title: '亞麻短袖 - 電商版 (zh-TW)',
          platform: 'shopify',
          language: 'zh-TW',
          brief: `### Marketing angle
台灣濕熱夏天通勤族，怕熱怕悶；切「機能透氣」+ 在地實穿。

### Key messages
- 180g 亞麻不悶熱
- 可機洗

### Copy brief
**Tone**: warm, professional
**Features to highlight**: fabric weight, washability
**Forbidden claims**: 無

### Image plan
- **Hero (required)**：clean white background`,
          assignedAgent: 'product-designer',
        },
      ],
    });
    // Report-writer LLM call for schemaName='product-plan'. NOTE: NO extra
    // scriptStructured here — supervisor short-circuits without an LLM call
    // when awaitingApproval=true (src/orchestrator/supervisor.ts:69-72), so
    // adding one would leak into the queue and be consumed by report-writer's
    // plain `.invoke()`.
    scriptText(
      '## 我的策略\n\n反向操作 SERP 悶熱恐懼。\n\n## 為什麼這樣選\n\n台灣夏天通勤族對亞麻有刻板印象，正面挑戰反而能站穩位置。',
    );

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'List this linen shirt for Taiwan market' },
    });
    expect(create.statusCode).toBe(201);
    const plannerTaskId = create.json().id as string;

    await drainNextTask();
    const plannerTask = await getTask(tenantId, plannerTaskId);
    expect(plannerTask.status).toBe('waiting');
    expect(plannerTask.kind).toBe('strategy');
    expect((plannerTask.output as { spawnTasks?: unknown[] })?.spawnTasks).toHaveLength(1);
    // Post-PR4: planner emits structuredOutput → report-writer renders prose.
    expect(plannerTask.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer, contains the prose it
        // generated — NOT a verbatim copy of structuredOutput.data.overview.
        report: expect.stringContaining('反向操作 SERP 悶熱恐懼'),
        body: expect.stringContaining('## 市場觀察'),
      },
      lastStructuredOutput: {
        schemaName: 'product-plan',
        data: expect.objectContaining({
          overview: expect.stringContaining('## 市場觀察'),
          variants: expect.arrayContaining([
            expect.objectContaining({ title: '亞麻短袖 - 電商版 (zh-TW)' }),
          ]),
        }),
        keyDocs: expect.anything(), // placeholder — see Step 2
      },
    });
```

> **Step 2 (typo guard):** the literal `keyDocs` in the snippet above is a typo planted intentionally — the field is `keyDecisions`. After pasting, change `keyDocs: expect.anything(),` to `keyDecisions: expect.arrayContaining(['反向操作 SERP 悶熱恐懼，主打 180g 不悶']),`. (The original placeholder must not survive — it would silently match anything.)

**Step 3: Verify the `scriptText` import is already present**

The file imports `scriptStructured` and `scriptToolCall` (lines 17–19). Confirm `scriptText` is also in the import block; if not, add it:

```bash
grep "scriptText" tests/integration/product-publisher.test.ts | head -3
```

If missing, edit lines 14–22 to add `scriptText` between `scriptStructured` and `scriptToolCall`:

```ts
import {
  clearScript,
  llmMockModule,
  scriptStructured,
  scriptText,
  scriptToolCall,
} from './helpers/llm-mock.js';
```

**Step 4: Run the targeted file**

```bash
pnpm test:integration -- tests/integration/product-publisher.test.ts
```

Expected: 1 passing.

Likely failure modes:
- **`task.output.artifact.report` is `undefined` or doesn't contain '反向操作 SERP'** — report-writer didn't fire, or the script-queue ordering is wrong. Verify there's exactly one `scriptStructured` (hop 1, supervisor route) + one `scriptToolCall` (hop 2, agent submit) + one `scriptText` (hop 3, report-writer). NO post-agent `scriptStructured` — supervisor short-circuits when `awaitingApproval=true`.
- **`task.output.artifact.body` is `undefined`** — the agent migration in Phase A didn't land. Re-run `pnpm test -- tests/product-planner.test.ts` from the worktree to confirm the unit test still passes.
- **`lastStructuredOutput.schemaName` is `undefined`** — graph.ts not surfacing it. Re-read `src/orchestrator/graph.ts:132-143` and `src/tasks/runner.ts:187-188` to confirm wiring (PR1 invariants — should still hold).

**Step 5: Run the full integration suite**

```bash
pnpm test:integration
```

Expected: 104 passing. Designer + publisher phases (lines 160+ of the test) keep working because those agents haven't migrated yet — their report-writer hops no-op on `lastStructuredOutput=null`.

**Step 6: Typecheck + lint**

```bash
pnpm typecheck
pnpm lint
```

Both expected clean.

**Step 7: Commit**

Stage exactly: `tests/integration/product-publisher.test.ts`.

```bash
git add tests/integration/product-publisher.test.ts
git commit -m "$(cat <<'EOF'
test(integration): wire planner phase to report-writer + structuredOutput

End-to-end verification that the migrated product-planner flows through
the new contract without breaking the spawn chain to designer/publisher:

- Add `keyDecisions[]` to the scripted `submit_plan` args.
- Add `scriptText(...)` for the report-writer LLM call that fires after
  the planner returns `awaitingApproval=true`. (Supervisor short-circuits
  without an LLM call when `awaitingApproval=true` — only ONE scripted
  text entry needed, not an extra `scriptStructured`.)
- New planner-phase assertions: `task.output.lastStructuredOutput.schemaName
  === 'product-plan'`, `data.overview`/`data.variants` populated,
  `artifact.body` carries the synthesis, `artifact.report` carries the
  report-writer's prose (NOT a verbatim copy of body).
- Designer + publisher phases unchanged: those agents haven't migrated
  yet (PR6, PR7), so their report-writer hops no-op on null
  lastStructuredOutput.

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
- unit: 207 passing (206 baseline + 1 new structuredOutput spec)
- integration: 104 passing (no count change — Task 4 modifies existing E2E rather than adding new file)

If any number is short, stop and diagnose before finishing.

**Step 2: Hand off to finishing-a-development-branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."

**REQUIRED SUB-SKILL:** Use `superpowers:finishing-a-development-branch`. Present the 4 standard options. The expected user choice (matching PR1/PR2/PR3 cadence) is "Merge to main locally" — when chosen:
1. `git checkout main`
2. `git pull` (no-op if origin hasn't moved; PR3 isn't pushed yet so local main is the source of truth)
3. `git merge feat/graph-refactor-pr4` (ff expected)
4. Re-run `pnpm test` on merged main as a smoke check
5. `git branch -d feat/graph-refactor-pr4`
6. `git worktree remove .worktrees/graph-refactor-pr4`

**Do NOT push to origin without explicit user confirmation** — same convention as PR1/PR2/PR3.

---

## Risks & mitigations

**R1 — Schema field shape: `overview` field stays put**
Unlike PR3 (`market-researcher` renamed `report` → `body`), PR4 keeps `overview` as the schema field name and just moves the synthesized output to `artifact.body`. **Why:** `overview` is more semantic for a strategy plan than `body`; the synthesis already includes both `overview` and per-variant subsections, so calling the synthesis result `body` makes sense for the artifact wire format without reshaping the LLM contract. **Mitigation:** the unit test's first spec explicitly asserts the synthesis lives on `artifact.body` and `artifact.report` is absent — catches any wrong-direction migration.

**R2 — `data.variants` size bloat in `lastStructuredOutput`**
Two variants × ~500 chars each ≈ 1KB. Not a concern. With 5 variants × 2KB briefs ≈ 10KB, still well within Postgres jsonb limits. Same data round-trips through `output.spawnTasks` today anyway. **No mitigation needed.**

**R3 — `artifact.body` consumers are surprised**
Today, the planner's only artifact field is `report`. UI consumers reading `task.output.artifact.report` will now see report-writer's prose (NOT the synthesized plan). The synthesis is on `artifact.body`. **Mitigation:** API consumers should already handle both `report` and `body` (PR2 made them both optional in `src/tasks/artifact.ts`). UI team sees richer data, not less. If UX needs a "preview" of the variants pre-approval, they're already in `task.output.spawnTasks[*].input.brief` — accessible without `artifact.body`.

**R4 — Integration test extra LLM call**
The E2E test now scripts one extra `scriptText` for report-writer. Forgetting it would surface as `task.output.artifact.report` being undefined (or, worse, falling back to the error string `'> ⚠️ 匯報生成失敗...'` which the assertion `stringContaining('反向操作 SERP 悶熱恐懼')` would still catch). **Mitigation:** the assertion at Phase B Step 1 explicitly checks for prose-specific text that ONLY appears in the scripted report-writer text — a silent fallback would FAIL the assertion.

**R5 — Future PRs (PR5–7) read this file as a recipe**
Per PR3's lesson, narrative documentation lines like "Task ends in `done`" or fixture lengths below schema minimums must match what the test actually does. **Mitigation:** every fixture in this plan is real working code copied from current production fixtures + the agent's actual schema constraints (overview min 100, brief min 80). No invented values.

**R6 — `pinnedAgent` continuity for spawned designer task**
After approving the planner, the spawned designer task carries `assignedAgent='product-designer'`. The runner sets `pinnedAgent` from `task.assignedAgent` (PR2 wiring), so the supervisor short-circuits and routes directly to designer without a structured-output LLM call. The integration test relies on this — there's no `scriptStructured` between the planner approve and the designer's `submit_listing`. **Mitigation:** this is existing PR2 behaviour; PR4 doesn't touch it. If it breaks, surface immediately because the E2E suite would fail at Phase 3.

---

## Out of scope (deferred to later PRs)

- Per-schema `REPORT_TEMPLATES` entries — generic system prompt is sufficient (see PR3 §"R2").
- Migrating `seo-strategist` (PR5), `product-designer` (PR6), `shopify-publisher` (PR7) — same recipe per PR, with each agent's own twists (PR5 spawns into the workflow, PR6 has `payload.content` plumbing, PR7 doesn't even call an LLM and includes a rename to `shopify-product-publisher`).
- Pushing to `origin` — gated on explicit user confirmation per PR1/PR2/PR3 convention.
- Removing the `body` / `report` field overlap in the artifact wire format — addressed in PR10 (cleanup PR).
