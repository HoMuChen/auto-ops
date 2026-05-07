# Graph Refactor PR5: Migrate `seo-strategist` — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the `seo-strategist` agent (the second strategy agent — fans out into the `seo-article-with-eeat` workflow) to PR1's `lastStructuredOutput` channel — add `keyDecisions[]` to the schema, move the synthesized markdown deliverable from `artifact.report` to `artifact.body`, and emit `structuredOutput` with `schemaName='topic-plan'` so the shared report-writer node renders the boss-facing prose at the HITL boundary.

**Architecture:**
- Same recipe as PR4 (`product-planner`). Schema field `overview` stays put; add `keyDecisions[]` (3–5 short bullets the report-writer reads).
- `invoke()` keeps the existing synthesis (`overview + ### {topic.title}\n\n{topic.writerBrief}` joined) but writes it to `artifact.body` (was `artifact.report`). Spawn-children plumbing (`spawnTasks` → workflow children) is unchanged.
- Emits `structuredOutput { schemaName: 'topic-plan', data: { overview, topics }, keyDecisions }` on the inter-node bus.
- `manifest.metadata` gains `shape: 'atomic'` alongside the existing `kind: 'strategy'`.
- Mid-migration coexistence: downstream workflow children (`seo-article-with-eeat` → `eeat-interviewer` + `article-writer`) are PR2-migrated, so their report-writer hops already work. Other unmigrated agents (product-designer, shopify-publisher) untouched.

**Tech Stack:** TypeScript, Zod, vitest. House LLM gateway is OpenRouter via `buildModel()`. Test style: `vi.mock` for unit, real Supabase + `llm-mock` (`scriptStructured` + `scriptText` + `scriptToolCall`) for integration.

**Design ref:** `docs/plans/2026-05-07-graph-refactor-design.md` §"PR3–7", §"`report-writer` node", §"`IAgent` contract changes". Reference shape: PR4's `product-planner` migration (`docs/plans/2026-05-07-graph-refactor-pr4-impl.md`); the `topic-plan` schemaName + `topics` array (instead of `variants`) are this PR's only twists.

---

## Pre-flight

```bash
pnpm typecheck             # expect: clean
pnpm lint                  # expect: clean
pnpm test                  # expect: 207 passed (PR4 baseline)
pnpm test:integration      # expect: 104 passed
```

If baseline isn't green, stop — PR5 lands on a clean main or not at all.

**Worktree setup:** Use `superpowers:using-git-worktrees` to create `.worktrees/graph-refactor-pr5` on branch `feat/graph-refactor-pr5`. Copy `.env` from the primary worktree (`cp /Users/largitdata/project/auto-ops/.env .env`) so integration tests can resolve `DATABASE_URL`.

**Scope sanity check (run from the worktree):**

```bash
grep -rn "seo-strategist\|seoStrategist" src/ tests/ --include="*.ts"
```

Expected matches (anything else surfaces, stop and re-scope):
- `src/agents/builtin/seo-strategist/index.ts` — the agent
- `src/agents/index.ts` — bootstrap registration (no change needed; id stays the same)
- `tests/seo-strategist.test.ts` — unit test (rewriting in Task 1+2)
- `tests/integration/seo-cluster.test.ts` — E2E test that walks `strategist → seo-article-with-eeat workflow → publish`. Updating the strategist phase in Task 4
- `tests/integration/spawning.test.ts` — E2E test that walks `strategist → spawn 2 workflow children`. Updating the strategist phase in Task 4
- `tests/integration/setup.ts` — references the agent id as a string (no change)
- `tests/integration/skill-packs-loader.integration.test.ts` and `tests/integration/skill-packs-repository.test.ts` — `appliesTo: ['seo-strategist']` string fixtures (no behavioural dep; **do not touch**)
- `tests/smoke/openrouter.test.ts` — has its own divergent inline `PlanSchema` (uses `reasoning` not `overview`); intentionally maintained on its own cadence (it's a "model availability smoke test", not a contract test). **Do not touch.**
- `src/agents/builtin/product-planner/index.ts` — references the strategist in a doc comment only; **do not touch**.
- `src/agents/builtin/product-designer/index.ts` — references the strategist in a doc comment only; **do not touch**.

---

## Phase A — Migrate the agent (TDD, single commit)

### Task 1: Rewrite the unit test to assert the new shape (RED)

**Files:**
- Modify: `tests/seo-strategist.test.ts` — fixture + 9 specs (was 8). Two callouts:
  - The existing `'emits an Artifact{report} with the overview and per-topic sections'` spec is renamed and asserts `artifact.body` instead of `artifact.report`.
  - The existing `'throws at invoke time if the LLM hallucinates an unknown assignedAgent'` spec has its OWN inline plan (not the shared `planFixture`) — that inline plan must also gain `keyDecisions: [...]` or the schema validation will reject the submission and the test never reaches the worker-id check.

**Step 1: Apply the fixture-level edits**

In `tests/seo-strategist.test.ts`, find the existing `planFixture` block (lines ~11-76) and add `keyDecisions` between `progressNote` and `topics`:

```ts
const planFixture = {
  overview: `## 市場觀察
... (unchanged)`,
  progressNote: '規劃了 2 個主軸，圍繞夏季 + 永續，老闆過目',
  keyDecisions: [
    '兩條主軸：在地穿搭實戰 vs 永續材質採購',
    '挑兩篇打不重疊：zh-TW 切在地通勤、en 切採購標準',
    '台灣濕熱氣候是市場切角，競品多半從歐美觀點寫',
  ],
  topics: [
    /* ... unchanged ... */
  ],
};
```

**Step 2: Rename + edit the existing "Artifact{report}" spec**

Find the existing spec block at lines ~194-210:

```ts
  it('emits an Artifact{report} with the overview and per-topic sections', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });
    const artifact = result.artifact;
    expect(artifact).toBeDefined();
    expect(artifact).toHaveProperty('report');
    expect(artifact).not.toHaveProperty('kind');
    expect(artifact).not.toHaveProperty('data');
    if (artifact && 'report' in artifact) {
      expect(artifact.report).toContain('## 市場觀察');
      expect(artifact.report).toContain('### 夏季穿搭 5 個必備單品');
      expect(artifact.report).toContain('### Sustainable summer fabrics buyer guide');
    }
  });
```

Replace with:

```ts
  it('emits Artifact{body} with the overview + per-topic sections (no agent-written report)', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });
    const artifact = result.artifact;
    expect(artifact).toBeDefined();
    // The agent no longer writes report — that's report-writer's job now.
    expect(artifact).not.toHaveProperty('report');
    expect(artifact).toHaveProperty('body');
    if (artifact && 'body' in artifact) {
      expect(artifact.body).toContain('## 市場觀察');
      expect(artifact.body).toContain('### 夏季穿搭 5 個必備單品');
      expect(artifact.body).toContain('### Sustainable summer fabrics buyer guide');
    }
  });

  it('surfaces structuredOutput on the inter-node bus for report-writer', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });

    expect(result.structuredOutput?.schemaName).toBe('topic-plan');
    expect(result.structuredOutput?.data).toMatchObject({
      overview: expect.stringContaining('## 市場觀察'),
      topics: expect.arrayContaining([
        expect.objectContaining({
          title: '夏季穿搭 5 個必備單品',
          primaryKeyword: '夏季穿搭',
          language: 'zh-TW',
          assignedAgent: 'article-writer',
          writerBrief: expect.stringContaining('搜尋意圖'),
        }),
      ]),
    });
    expect(
      (result.structuredOutput?.data as { topics: unknown[] } | undefined)?.topics,
    ).toHaveLength(2);
    expect(result.structuredOutput?.keyDecisions).toEqual(planFixture.keyDecisions);
  });
```

This deepens the variants assertion at the same level PR4's code review demanded (full topic shape + length check), preventing a "byte-shaving" regression.

**Step 3: Patch the inline plan in the "unknown worker" spec**

Find the existing spec block at lines ~221-254. The inline `args` object passed to `toolPassInvokeMock.mockResolvedValueOnce(...)` is missing `keyDecisions`. After PR5 the schema requires it, so without this edit the test never reaches the worker-id-validation step.

Find:

```ts
    toolPassInvokeMock.mockResolvedValueOnce({
      content: '',
      tool_calls: [
        {
          id: 'call_submit_bad',
          name: 'submit_plan',
          args: {
            overview:
              '## 觀察\n\n為了測試錯誤處理，這份規劃故意指派一個不存在的 worker，預期框架會擋下並丟錯。' +
              '本段 overview 必須夠長（≥100 字元）才能通過 Zod 的 min(100) 驗證；不然 runToolLoop 會把 submit 視為無效並重新 prompt 模型，走進 default fixture path。',
            progressNote: '計畫好了但 worker 名稱可能有誤',
            topics: [
              {
                title: 'whatever',
                primaryKeyword: 'kw',
                language: 'zh-TW',
                writerBrief:
                  '## Topic\n\nSomething long enough to satisfy the schema minimum length so the test reaches the worker-id validation step.',
                assignedAgent: 'nonexistent-writer',
              },
            ],
          },
        },
      ],
    });
```

Replace with the same block but inserting `keyDecisions` between `progressNote` and `topics`:

```ts
    toolPassInvokeMock.mockResolvedValueOnce({
      content: '',
      tool_calls: [
        {
          id: 'call_submit_bad',
          name: 'submit_plan',
          args: {
            overview:
              '## 觀察\n\n為了測試錯誤處理，這份規劃故意指派一個不存在的 worker，預期框架會擋下並丟錯。' +
              '本段 overview 必須夠長（≥100 字元）才能通過 Zod 的 min(100) 驗證；不然 runToolLoop 會把 submit 視為無效並重新 prompt 模型，走進 default fixture path。',
            progressNote: '計畫好了但 worker 名稱可能有誤',
            keyDecisions: ['故意指派不存在的 worker 來驗證錯誤處理'],
            topics: [
              {
                title: 'whatever',
                primaryKeyword: 'kw',
                language: 'zh-TW',
                writerBrief:
                  '## Topic\n\nSomething long enough to satisfy the schema minimum length so the test reaches the worker-id validation step.',
                assignedAgent: 'nonexistent-writer',
              },
            ],
          },
        },
      ],
    });
```

**Step 4: Don't run the suite for RED** — go straight to GREEN.

---

### Task 2: Migrate the agent (GREEN)

**Files:**
- Modify: `src/agents/builtin/seo-strategist/index.ts` (schema, invoke, manifest, prompt)

**What:** Five coordinated edits in one file:

1. **DEFAULT_PROMPT:** add lines about `keyDecisions` to the "Submitting your plan" section AND add a paragraph telling the LLM not to write a boss memo into `overview`.
2. **`PlanSchema`:** add `keyDecisions: z.array(z.string().min(5)).min(1).max(5)` between `progressNote` and `topics`.
3. **`invoke()`:** rename the synthesized `report` local variable to `body`; return `artifact: { body }` instead of `{ report }`; add `structuredOutput` block.
4. **emitLog `agent.plan.ready` payload:** `artifactShape: 'body+structuredOutput'` (was `'report'`).
5. **Manifest:** `metadata: { kind: 'strategy', shape: 'atomic' }` (was `{ kind: 'strategy' }`).

**Step 1: Apply the prompt update at lines 62-82**

Find the existing block:

```
# Submitting your plan — the ONLY way to finish

When you have enough SERP data, **call the \`submit_plan\` tool**. The tool
arguments ARE your final deliverable: \`overview\` (zh-TW Markdown explaining
the overall strategy), \`progressNote\` (one-line status for the kanban),
and \`topics\` (the array of focused articles). There is no other channel —
nothing you write as plain text reaches the user.
```

Replace with:

```
# Submitting your plan — the ONLY way to finish

When you have enough SERP data, **call the \`submit_plan\` tool**. The tool
arguments ARE your final deliverable: \`overview\` (zh-TW Markdown explaining
the overall strategy), \`progressNote\` (one-line status for the kanban),
\`keyDecisions\` (3-5 short bullets the report-writer can lean on when generating
boss-facing prose; these are NOT boss-facing prose themselves), and \`topics\`
(the array of focused articles). There is no other channel — nothing you write
as plain text reaches the user.

The boss-facing 匯報 (memo) is rendered by a separate report-writer node from
your structured output. Do NOT write a boss memo into \`overview\` — that field
is the strategy narrative for downstream consumers, not the executive summary.
```

(The "Anti-patterns" section that follows at line 70+ stays unchanged.)

**Step 2: Add `keyDecisions` to `PlanSchema` at lines 129-148**

In `PlanSchema`, between `progressNote` and `topics`, add:

```ts
  keyDecisions: z
    .array(z.string().min(5))
    .min(1)
    .max(5)
    .describe(
      '3-5 short bullets the downstream report-writer can lean on when generating boss prose. ' +
        'Examples: "兩條主軸：在地穿搭 vs 永續材質", "台灣濕熱氣候是切角". ' +
        'Be concrete about strategic angles, market gaps, and recommended hooks. Not boss-facing prose itself.',
    ),
```

After this edit, `PlanSchema` looks like:

```ts
const PlanSchema = z.object({
  overview: z.string().min(100).max(4000).describe(/* unchanged */),
  progressNote: z.string().min(10).max(200).describe(/* unchanged */),
  keyDecisions: z.array(z.string().min(5)).min(1).max(5).describe(/* see above */),
  topics: z.array(TopicSchema).min(1),
});
```

**Step 3: Update the manifest at line 165**

Change:

```ts
    metadata: { kind: 'strategy' },
```

To:

```ts
    metadata: { kind: 'strategy', shape: 'atomic' },
```

**Step 4: Update `invoke()` return shape at lines 272-287**

Find the existing block:

```ts
      await ctx.emitLog('agent.plan.ready', plan.progressNote, {
        artifactShape: 'report',
        topicCount: capped.length,
      });

      const report = [
        plan.overview,
        ...capped.map((t) => `### ${t.title}\n\n${t.writerBrief}`),
      ].join('\n\n');

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
        topicCount: capped.length,
      });

      const body = [
        plan.overview,
        ...capped.map((t) => `### ${t.title}\n\n${t.writerBrief}`),
      ].join('\n\n');

      // NOTE: artifact.report intentionally absent — the shared report-writer
      // node fills it from state.lastStructuredOutput at the HITL boundary.
      return {
        message: plan.progressNote,
        awaitingApproval: true,
        artifact: { body },
        spawnTasks,
        structuredOutput: {
          schemaName: 'topic-plan',
          data: {
            overview: plan.overview,
            topics: capped,
          },
          keyDecisions: plan.keyDecisions,
        },
      };
    };
```

**Step 5: Run the unit test for this file**

```bash
pnpm test -- tests/seo-strategist.test.ts
```

Expected: 9 specs passing (was 8 before; the structuredOutput spec is new).

**Step 6: Run the full unit suite to catch ripple-effect breakage**

```bash
pnpm test
```

Expected: 208 passing (207 baseline + 1 new structuredOutput spec).

---

### Task 3: Typecheck, lint, commit

**Step 1: Typecheck + lint**

```bash
pnpm typecheck    # expect: clean
pnpm lint         # expect: clean (run pnpm lint:fix if formatting nits)
```

**Step 2: Commit (single commit — schema + invoke + test together)**

Stage exactly:
- `src/agents/builtin/seo-strategist/index.ts`
- `tests/seo-strategist.test.ts`

```bash
git add src/agents/builtin/seo-strategist/index.ts tests/seo-strategist.test.ts
git commit -m "$(cat <<'EOF'
feat(seo-strategist): emit structuredOutput; report-writer renders prose

- Schema: add `keyDecisions[]`. `overview` / `progressNote` / `topics`
  unchanged.
- Invoke: move the synthesized markdown deliverable from `artifact.report`
  to `artifact.body`; emit `structuredOutput` with `schemaName='topic-plan'`
  so the shared report-writer node (PR1) renders the boss-facing prose at
  the HITL boundary. `spawnTasks` plumbing into worker agents (article-writer
  or seo-article-with-eeat workflow) is unchanged.
- Manifest: tag as `{ kind: 'strategy', shape: 'atomic' }` for symmetry
  with the PR2/PR3/PR4-migrated agents.
- Prompt: explicitly tells the LLM not to write boss prose into `overview`
  (that's report-writer's job) and explains the new `keyDecisions` field.
- Unit test: rewrite fixture (`keyDecisions[]` added to both `planFixture`
  and the inline plan in the "unknown worker" spec); the synthesis spec
  now asserts on `artifact.body` instead of `artifact.report`; new spec
  asserts the `structuredOutput` bus payload (with full topic shape + length
  check, matching the PR4 code-review depth).

PR5 of the graph-refactor migration. Mid-migration coexistence holds:
the downstream workflow children (seo-article-with-eeat → eeat-interviewer
+ article-writer) are PR2-migrated already, so the article-writer's own
report-writer hop continues to work. Other unmigrated agents
(product-designer, shopify-publisher) untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Update the integration tests

PR5 touches **two** existing E2E integration tests (not one like PR4). Both have the same kind of update — add `keyDecisions` to the strategist's `submit_plan` script, add a `scriptText` for the strategist's report-writer LLM call, and update assertions for the new `artifact.body`/`artifact.report` split + `lastStructuredOutput`. Combining them into one commit (Task 4) reduces churn since they're closely related.

### Task 4: Update both integration tests

**Files:**
- Modify: `tests/integration/seo-cluster.test.ts` (strategist phase only)
- Modify: `tests/integration/spawning.test.ts` (strategist phase only)

**What for each file:** three small edits in the strategist phase only:
1. Add `keyDecisions: [...]` to the scripted `submit_plan` args.
2. Add `scriptText(...)` AFTER the `submit_plan` scriptToolCall (supervisor short-circuits without an LLM call when `awaitingApproval=true` per `src/orchestrator/supervisor.ts:69-72`, so NO extra `scriptStructured`).
3. Extend the strategist-phase assertions to cover `lastStructuredOutput` + the new `artifact.body`/`artifact.report` split.

Downstream phases (workflow child tasks) are untouched.

#### Step 1: Edit `tests/integration/seo-cluster.test.ts`

Find the existing block at lines 122-163 (Phase 1: strategist runs):

```ts
    // ── Phase 1: Strategist runs (supervisor + two-pass tool+plan) ────────────
    // Supervisor routes to seo-strategist (structured).
    scriptStructured({ nextAgent: 'seo-strategist', clarification: null, done: false });
    // Strategist now submits the plan via the submit_plan tool (single-pass).
    scriptToolCall('submit_plan', {
      overview:
        '## 觀察\n\n聚焦亞麻襯衫單一主題，驗證 EEAT 流程。研究 SERP 後發現 PAA 主集中在保養' +
        '與穿著體驗，related searches 圍繞「縮水」與「洗滌方式」。\n\n## 策略\n\n切角放在' +
        '台灣濕熱氣候下的真實穿著體驗與第一手洗滌數據，這是市場缺口。',
      progressNote: '規劃了 1 個主題，用來測試 EEAT 流程，老闆過目',
      topics: [
        {
          title: 'Linen shirts summer guide',
          primaryKeyword: 'linen shirt summer',
          language: 'en',
          writerBrief:
            '**Search intent**: commercial\n\n### PAA\n- Is linen good for summer?\n- How to care for linen?\n\n### Related queries\n- linen vs cotton summer\n- best linen shirts 2026\n\n### Competitor gap\nNo Taiwan humidity specifics.\n\n### Target\n~1200 words. Comprehensive guide on linen shirts for humid summer climates.\n\n### E-E-A-T hook\nBoss should share washing experience and wearability in humid heat.',
          assignedAgent: 'seo-article-with-eeat',
        },
      ],
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'Plan a linen shirt SEO article for summer' },
    });
    expect(create.statusCode).toBe(201);
    const parentId = create.json().id as string;

    const drained = await drainNextTask();
    expect(drained.taskId).toBe(parentId);

    const parent = await getTask(tenantId, parentId);
    expect(parent.status).toBe('waiting');
    expect(parent.kind).toBe('strategy');
    expect(parent.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('Linen shirts summer guide'),
      },
    });
```

Replace with:

```ts
    // ── Phase 1: Strategist runs (supervisor + tool-loop + report-writer) ─────
    // Supervisor routes to seo-strategist (structured).
    scriptStructured({ nextAgent: 'seo-strategist', clarification: null, done: false });
    // Strategist now submits the plan via the submit_plan tool (single-pass).
    scriptToolCall('submit_plan', {
      overview:
        '## 觀察\n\n聚焦亞麻襯衫單一主題，驗證 EEAT 流程。研究 SERP 後發現 PAA 主集中在保養' +
        '與穿著體驗，related searches 圍繞「縮水」與「洗滌方式」。\n\n## 策略\n\n切角放在' +
        '台灣濕熱氣候下的真實穿著體驗與第一手洗滌數據，這是市場缺口。',
      progressNote: '規劃了 1 個主題，用來測試 EEAT 流程，老闆過目',
      keyDecisions: [
        '聚焦單一主題驗證 EEAT 流程',
        '切角放在台灣濕熱氣候下的真實穿著與洗滌數據',
      ],
      topics: [
        {
          title: 'Linen shirts summer guide',
          primaryKeyword: 'linen shirt summer',
          language: 'en',
          writerBrief:
            '**Search intent**: commercial\n\n### PAA\n- Is linen good for summer?\n- How to care for linen?\n\n### Related queries\n- linen vs cotton summer\n- best linen shirts 2026\n\n### Competitor gap\nNo Taiwan humidity specifics.\n\n### Target\n~1200 words. Comprehensive guide on linen shirts for humid summer climates.\n\n### E-E-A-T hook\nBoss should share washing experience and wearability in humid heat.',
          assignedAgent: 'seo-article-with-eeat',
        },
      ],
    });
    // Report-writer LLM call for schemaName='topic-plan'. NOTE: NO extra
    // scriptStructured here — supervisor short-circuits without an LLM call
    // when awaitingApproval=true (src/orchestrator/supervisor.ts:69-72), so
    // adding one would leak into the queue and be consumed by report-writer's
    // plain `.invoke()`.
    scriptText(
      '## 策略決定\n\n聚焦台灣濕熱氣候的第一手經驗。\n\n## 為什麼這樣選\n\n是市場切角，競品多半從歐美觀點寫，缺少在地實穿與洗滌數據。',
    );

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'Plan a linen shirt SEO article for summer' },
    });
    expect(create.statusCode).toBe(201);
    const parentId = create.json().id as string;

    const drained = await drainNextTask();
    expect(drained.taskId).toBe(parentId);

    const parent = await getTask(tenantId, parentId);
    expect(parent.status).toBe('waiting');
    expect(parent.kind).toBe('strategy');
    // Post-PR5: strategist emits structuredOutput → report-writer renders prose.
    expect(parent.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer, contains the prose it
        // generated — NOT a verbatim copy of structuredOutput.data.overview
        // (the prose-unique substring '台灣濕熱氣候的第一手經驗' is ONLY in the
        // scripted text above; it is NOT in the agent's overview/topics).
        report: expect.stringContaining('台灣濕熱氣候的第一手經驗'),
        body: expect.stringContaining('Linen shirts summer guide'),
      },
      lastStructuredOutput: {
        schemaName: 'topic-plan',
        data: expect.objectContaining({
          overview: expect.stringContaining('## 觀察'),
          topics: expect.arrayContaining([
            expect.objectContaining({ title: 'Linen shirts summer guide' }),
          ]),
        }),
        keyDecisions: expect.arrayContaining(['聚焦單一主題驗證 EEAT 流程']),
      },
    });
```

#### Step 2: Edit `tests/integration/spawning.test.ts`

Find the existing block at lines 67-126 (Phase 1):

```ts
    // ── Phase 1: parent strategy task ──────────────────────────────────────
    // Supervisor picks the strategist (structured), then the strategist
    // submits its plan via the submit_plan tool (single-pass tool-loop).
    scriptStructured({
      nextAgent: 'seo-strategist',
      clarification: null,
      done: false,
    });
    scriptToolCall('submit_plan', {
      overview:
        '## 觀察\n\n夏季 SEO 主要兩條主軸：本地穿搭實戰、永續材質採購。台灣濕熱氣候是市場切角，' +
        '競品多半從歐美觀點寫，缺少在地實穿與洗滌經驗。\n\n## 策略\n\n選兩篇打不重疊：' +
        'zh-TW 在地穿搭主打台灣通勤痛點，en 永續 buyer guide 主打採購標準與第一手洗滌數據。',
      progressNote: '規劃了 2 個切角，主軸是夏季關鍵字，老闆過目',
      topics: [
        {
          title: '夏季穿搭 5 個必備單品',
          primaryKeyword: '夏季穿搭',
          language: 'zh-TW',
          writerBrief:
            '**搜尋意圖**: commercial\n\n### PAA\n- Is linen good for summer?\n\n### 競品缺口\n沒有台灣濕熱氣候的穿搭建議。\n\n### 目標\n1500 字 long-form article on layered summer styling for humid Taiwan climate.',
          assignedAgent: 'seo-article-with-eeat',
        },
        {
          title: 'Sustainable summer fabrics buyer guide',
          primaryKeyword: 'sustainable fabrics summer',
          language: 'en',
          writerBrief:
            '**Search intent**: informational\n\n### PAA\n- What is the most sustainable fabric?\n\n### Competitor gap\nNo first-hand washing data.\n\n### Target\nBuyer guide comparing linen, organic cotton and Tencel for summer apparel.',
          assignedAgent: 'seo-article-with-eeat',
        },
      ],
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'Plan the summer SEO campaign for our store' },
    });
    expect(create.statusCode).toBe(201);
    const parentId = create.json().id as string;

    // Drive the worker to run the strategy task.
    const drained = await drainNextTask();
    expect(drained.taskId).toBe(parentId);

    let parent = await getTask(tenantId, parentId);
    expect(parent.status).toBe('waiting');
    // Runner should auto-promote kind because the agent emitted spawnTasks.
    expect(parent.kind).toBe('strategy');
    // The plan (markdown report) and the pending children specs should both be in output.
    expect(parent.output).toMatchObject({
      artifact: {
        report: expect.any(String),
      },
      spawnTasks: expect.arrayContaining([
        expect.objectContaining({ assignedAgent: 'seo-article-with-eeat' }),
      ]),
    });
```

Replace with:

```ts
    // ── Phase 1: parent strategy task ──────────────────────────────────────
    // Supervisor picks the strategist (structured), then the strategist
    // submits its plan via the submit_plan tool (single-pass tool-loop).
    scriptStructured({
      nextAgent: 'seo-strategist',
      clarification: null,
      done: false,
    });
    scriptToolCall('submit_plan', {
      overview:
        '## 觀察\n\n夏季 SEO 主要兩條主軸：本地穿搭實戰、永續材質採購。台灣濕熱氣候是市場切角，' +
        '競品多半從歐美觀點寫，缺少在地實穿與洗滌經驗。\n\n## 策略\n\n選兩篇打不重疊：' +
        'zh-TW 在地穿搭主打台灣通勤痛點，en 永續 buyer guide 主打採購標準與第一手洗滌數據。',
      progressNote: '規劃了 2 個切角，主軸是夏季關鍵字，老闆過目',
      keyDecisions: [
        '兩條主軸：在地穿搭 vs 永續材質採購',
        '台灣濕熱氣候是切角，競品多半從歐美視角',
        '挑兩篇打不重疊：zh-TW 通勤痛點 + en 採購標準',
      ],
      topics: [
        {
          title: '夏季穿搭 5 個必備單品',
          primaryKeyword: '夏季穿搭',
          language: 'zh-TW',
          writerBrief:
            '**搜尋意圖**: commercial\n\n### PAA\n- Is linen good for summer?\n\n### 競品缺口\n沒有台灣濕熱氣候的穿搭建議。\n\n### 目標\n1500 字 long-form article on layered summer styling for humid Taiwan climate.',
          assignedAgent: 'seo-article-with-eeat',
        },
        {
          title: 'Sustainable summer fabrics buyer guide',
          primaryKeyword: 'sustainable fabrics summer',
          language: 'en',
          writerBrief:
            '**Search intent**: informational\n\n### PAA\n- What is the most sustainable fabric?\n\n### Competitor gap\nNo first-hand washing data.\n\n### Target\nBuyer guide comparing linen, organic cotton and Tencel for summer apparel.',
          assignedAgent: 'seo-article-with-eeat',
        },
      ],
    });
    // Report-writer LLM call for schemaName='topic-plan'. NO extra
    // scriptStructured — supervisor short-circuits on awaitingApproval=true
    // (src/orchestrator/supervisor.ts:69-72).
    scriptText(
      '## 策略決定\n\n挑兩條主軸：在地穿搭 + 永續材質。\n\n## 為什麼這樣選\n\n台灣濕熱氣候是切角，競品多半從歐美視角寫。',
    );

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'Plan the summer SEO campaign for our store' },
    });
    expect(create.statusCode).toBe(201);
    const parentId = create.json().id as string;

    // Drive the worker to run the strategy task.
    const drained = await drainNextTask();
    expect(drained.taskId).toBe(parentId);

    let parent = await getTask(tenantId, parentId);
    expect(parent.status).toBe('waiting');
    // Runner should auto-promote kind because the agent emitted spawnTasks.
    expect(parent.kind).toBe('strategy');
    // Post-PR5: strategist emits structuredOutput → report-writer renders prose.
    expect(parent.output).toMatchObject({
      artifact: {
        // CRITICAL: report is report-writer's prose, contains scripted-only
        // substring '挑兩條主軸：在地穿搭 + 永續材質' (not present in agent
        // output). body is the synthesis containing the topic title.
        report: expect.stringContaining('挑兩條主軸：在地穿搭 + 永續材質'),
        body: expect.stringContaining('夏季穿搭 5 個必備單品'),
      },
      lastStructuredOutput: {
        schemaName: 'topic-plan',
        data: expect.objectContaining({
          overview: expect.stringContaining('## 觀察'),
          topics: expect.arrayContaining([
            expect.objectContaining({ title: '夏季穿搭 5 個必備單品' }),
          ]),
        }),
        keyDecisions: expect.arrayContaining(['兩條主軸：在地穿搭 vs 永續材質採購']),
      },
      spawnTasks: expect.arrayContaining([
        expect.objectContaining({ assignedAgent: 'seo-article-with-eeat' }),
      ]),
    });
```

#### Step 3: Verify `scriptText` is in the imports for both files

```bash
grep -n "scriptText" tests/integration/seo-cluster.test.ts tests/integration/spawning.test.ts
```

`seo-cluster.test.ts` already imports `scriptText` (line 26 — it's used later for the article-writer's report-writer call). `spawning.test.ts` may or may not — verify and add if missing:

```ts
import {
  clearScript,
  llmMockModule,
  scriptStructured,
  scriptText,
  scriptToolCall,
} from './helpers/llm-mock.js';
```

#### Step 4: Run both targeted files individually

```bash
pnpm test:integration -- tests/integration/seo-cluster.test.ts
pnpm test:integration -- tests/integration/spawning.test.ts
```

Each: 1 passing.

Likely failure modes:
- **`task.output.artifact.report` undefined or doesn't contain the prose-unique substring** — script-queue ordering is wrong. Verify exactly: 1 `scriptStructured` (hop 1, supervisor route) + 1 `scriptToolCall` (hop 2, agent submit) + 1 `scriptText` (hop 3, report-writer). NO post-agent `scriptStructured`.
- **`task.output.artifact.body` undefined** — Phase A migration didn't land. Re-run `pnpm test -- tests/seo-strategist.test.ts`.
- **`lastStructuredOutput.schemaName` undefined** — graph.ts/runner.ts wiring broken (PR1 invariants — should still hold).

If the test fails for a real reason (not script ordering), investigate but do NOT change product code.

#### Step 5: Run the full integration suite

```bash
pnpm test:integration
```

Expected: 104 passing total (no count change — both tests are modified, not added).

#### Step 6: Typecheck + lint + commit

```bash
pnpm typecheck
pnpm lint
```

Both expected clean.

Stage exactly: `tests/integration/seo-cluster.test.ts` and `tests/integration/spawning.test.ts`.

```bash
git add tests/integration/seo-cluster.test.ts tests/integration/spawning.test.ts
git commit -m "$(cat <<'EOF'
test(integration): wire seo-strategist phase to report-writer + structuredOutput

Update both E2E tests that exercise the strategist (seo-cluster +
spawning) for the post-PR5 contract:

- Add `keyDecisions[]` to the scripted `submit_plan` args in both files.
- Add `scriptText(...)` for the report-writer LLM call that fires after
  the strategist returns `awaitingApproval=true`. Supervisor short-
  circuits without an LLM call when awaitingApproval=true — only ONE
  scripted text entry needed, not an extra `scriptStructured`.
- New strategist-phase assertions in both files: `task.output
  .lastStructuredOutput.schemaName === 'topic-plan'`, `data.overview` /
  `data.topics` populated, `artifact.body` carries the synthesis,
  `artifact.report` carries the report-writer's prose (asserted via a
  prose-unique substring that ONLY appears in the scripted text — a
  silent fallback or accidental copy-from-body would FAIL).
- Downstream phases (workflow children) untouched. seo-cluster's
  article-writer phase already scripts its own `scriptText` (PR2).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Verify and finish

### Task 5: Full suite + finishing-a-development-branch

**Step 1: Final pre-merge verification**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
```

Expected:
- typecheck: clean
- lint: clean
- unit: 208 passing (207 baseline + 1 new structuredOutput spec)
- integration: 104 passing (no count change)

**Step 2: Hand off to finishing-a-development-branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."

**REQUIRED SUB-SKILL:** Use `superpowers:finishing-a-development-branch`. Present the 4 standard options. The expected user choice (matching PR1/PR2/PR3/PR4 cadence) is "Merge to main locally" — when chosen:
1. `git checkout main`
2. `git pull` (no-op or fast-forward; PR4 was pushed so origin should already match local main at commit `9a38d7c`)
3. `git merge feat/graph-refactor-pr5` (ff expected)
4. Re-run `pnpm test` on merged main as a smoke check
5. `git branch -d feat/graph-refactor-pr5`
6. `git worktree remove .worktrees/graph-refactor-pr5`

**Do NOT push to origin without explicit user confirmation** — same convention as PR1–PR4.

---

## Risks & mitigations

**R1 — Schema field shape: `overview` field stays put** (same as PR4)
The schema field name `overview` keeps its semantics (strategy narrative for downstream consumers). Only the artifact wire format moves (`report` → `body`).

**R2 — `data.topics` size bloat in `lastStructuredOutput`**
Up to 10 topics × ~2KB writerBrief each ≈ 20KB. Same data already round-trips through `output.spawnTasks` today (the strategist's child specs carry `writerBrief` in their `input.brief`). **No mitigation needed.**

**R3 — Inline plan in unit-test "unknown worker" spec**
Easy to forget: the unknown-worker spec has its own inline `args` object (not the shared `planFixture`). Without `keyDecisions` added to it, the schema validation will reject the plan and the test never reaches the worker-id check. **Mitigation:** Phase A Task 1 Step 3 explicitly calls this out and provides the verbatim diff.

**R4 — Two integration tests instead of one**
PR3 had 1 integration test (new); PR4 had 1 (existing E2E); PR5 has 2 (both existing E2E). Each gets the same pattern (keyDecisions + scriptText + extended assertions). Combined into one commit for review ergonomics. **Mitigation:** the plan provides verbatim diffs for both files, with prose-unique scriptText substrings that discriminate between report-writer prose and agent body.

**R5 — `pinnedAgent` continuity for spawned workflow children**
After approving the strategist, spawned child tasks carry `assignedAgent='seo-article-with-eeat'` (per PR2's strategist-spawns-into-workflow path). The runner sets `pinnedAgent` from `task.assignedAgent`, supervisor short-circuits, and routes directly to the workflow without an LLM call. The integration tests rely on this — there's no `scriptStructured` between strategist approve and workflow children running. **No PR5 change.** This is existing PR2 behaviour.

**R6 — Future PRs (PR6, PR7) read this file as a recipe**
Same lesson as PR4: every fixture in this plan is real working code (overview ≥ 100, writerBrief ≥ 80) copied from existing test fixtures + the agent's actual schema constraints. No invented values. The "supervisor short-circuits on awaitingApproval=true" warning is in both integration test snippets verbatim.

---

## Out of scope (deferred to later PRs)

- Per-schema `REPORT_TEMPLATES` entries — generic system prompt is sufficient.
- Migrating `product-designer` (PR6), `shopify-publisher` (PR7) — same recipe (with PR6 having `payload.content` plumbing for downstream publishers, and PR7 being a special case: no LLM call + a rename to `shopify-product-publisher`).
- Pushing to `origin` — gated on explicit user confirmation per PR1–PR4 convention.
- Removing the `body` / `report` field overlap in the artifact wire format — addressed in PR10 (cleanup PR).
- Updating `tests/smoke/openrouter.test.ts` — its inline `PlanSchema` is intentionally divergent (uses `reasoning` not `overview`); maintained on its own cadence as a "model availability smoke test".
