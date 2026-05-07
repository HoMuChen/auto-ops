# Graph Refactor PR6: Migrate `product-designer` — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the `product-designer` execution agent (already produces `artifact.body`; spawns publisher children) to PR1's `lastStructuredOutput` channel — drop `report` from the submit schema, add `keyDecisions[]`, stop writing `artifact.report` (let report-writer fill it), and emit `structuredOutput` with `schemaName='product-listing'`.

**Architecture:**
- Schema: drop `report` field; add `keyDecisions[]` (3–5 short bullets the report-writer reads). Other fields (`title`, `body`, `tags`, `vendor`, `productType`, `progressNote`) unchanged.
- `invoke()`: image markdown moves from `report` synthesis → appended to `artifact.body`, so images stay user-visible pre-approval. Agent emits `structuredOutput { schemaName: 'product-listing', data: { title, body, tags, vendor, productType, language, imageUrls }, keyDecisions }`.
- **Mid-migration plumbing for downstream publisher:** `payload.content.report` is preserved as a string (set to `body + imageMarkdown`) so the un-migrated `shopify-publisher` (PR7) keeps copying it into its own `artifact.report` without breakage. The semantic content shifts (body+images instead of boss prose) but the type contract holds. PR7 will rework this when `shopify-publisher` migrates.
- `manifest.metadata` gains `{ kind: 'execution', shape: 'atomic' }` (currently no metadata).
- Three test files touched: `tests/product-designer.test.ts` (unit), `tests/integration/product-publisher.test.ts` (E2E walking planner→designer→publisher), `tests/integration/image-style-e2e.integration.test.ts` (E2E for image style suffix).

**Tech Stack:** TypeScript, Zod, vitest. House LLM gateway is OpenRouter via `buildModel()`. Test style: `vi.mock` for unit, real Supabase + `llm-mock` (`scriptStructured` + `scriptText` + `scriptToolCall`) for integration.

**Design ref:** `docs/plans/2026-05-07-graph-refactor-design.md` §"PR3–7", §"`report-writer` node", §"`IAgent` contract changes". Reference shape: PR4's `product-planner` (`docs/plans/2026-05-07-graph-refactor-pr4-impl.md`) and PR5's `seo-strategist` (`docs/plans/2026-05-07-graph-refactor-pr5-impl.md`).

---

## Pre-flight

```bash
pnpm typecheck             # expect: clean
pnpm lint                  # expect: clean
pnpm test                  # expect: 208 passed (PR5 baseline)
pnpm test:integration      # expect: 104 passed
```

If baseline isn't green, stop — PR6 lands on a clean main or not at all.

**Worktree setup:** Use `superpowers:using-git-worktrees` to create `.worktrees/graph-refactor-pr6` on branch `feat/graph-refactor-pr6`. Copy `.env` from the primary worktree (`cp /Users/largitdata/project/auto-ops/.env .env`) so integration tests can resolve `DATABASE_URL`.

**Scope sanity check (run from the worktree):**

```bash
grep -rn "product-designer\|productDesigner\|submit_listing\|ProductListingSchema" src/ tests/ --include="*.ts"
```

Expected matches (anything else surfaces, stop and re-scope):
- `src/agents/builtin/product-designer/index.ts` — the agent
- `src/agents/builtin/shopify-publisher/content.ts` — `ProductContent` type definition. **Keep `report: string` field** (publisher consumes it); we just change what value the agent assigns. PR7 will rework this.
- `src/agents/index.ts` — bootstrap registration (no change; id stays the same)
- `tests/product-designer.test.ts` — unit test (rewriting in Task 1+2)
- `tests/integration/product-publisher.test.ts` — E2E (Phase 3 designer-phase update in Task 4)
- `tests/integration/image-style-e2e.integration.test.ts` — E2E (designer-phase update in Task 4)
- `tests/product-planner.test.ts` — references designer as a string fixture for the spawn assertion (no behavioural dep; **do not touch**)
- `src/agents/builtin/product-planner/index.ts` — references designer in a doc comment only (no change)
- `src/integrations/openai-images/build-tenant-image-tools.ts` — no change

---

## Phase A — Migrate the agent (TDD, single commit)

### Task 1: Rewrite the unit test to assert the new shape (RED)

**Files:**
- Modify: `tests/product-designer.test.ts` — fixture + 5 specs (was 4).

**What:** Three coordinated edits:
1. **Fixture:** drop `report`, add `keyDecisions`.
2. **Existing spec 3 (`'replaces imageUrls when LLM generates new images on feedback'`):** the assertion currently checks `artifact.report` for image markdown. Update it to check `artifact.body` instead (since images now ride on body).
3. **Existing spec 4 (`'emits an Artifact { report, body, refs }'`):** rename + assert `artifact` has `body`/`refs` but NOT `report`. Add a NEW spec for the structuredOutput payload.

**Step 1: Replace the file**

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ProductContent } from '../src/agents/builtin/shopify-publisher/content.js';

/**
 * product-designer (post-PR6): execution agent that receives a markdown
 * brief from product-planner, generates images via tool loop, writes
 * copy, then spawns publisher tasks.
 *
 * Post-PR6 contract:
 * - `artifact.body` = listing.body + image markdown (images stay user-visible
 *   pre-approval).
 * - `artifact.report` is filled by report-writer, NOT by the agent.
 * - `payload.content.report` = `body + imageMarkdown` (string preserved so
 *   un-migrated downstream publisher keeps working until PR7).
 * - `structuredOutput.schemaName='product-listing'` carries the deliverable
 *   for report-writer + downstream consumers.
 */

const listingFixture = {
  title: 'Linen Oversized Shirt',
  body: '## 主特色\n\n180g 亞麻、台灣製造、可機洗。\n\n- 不悶熱\n- 可機洗',
  tags: ['linen', 'summer', 'oversized'],
  vendor: 'Acme',
  keyDecisions: [
    '機能透氣切「台灣通勤」實戰，文案直接連結濕熱痛點',
    '從 brief 推斷 Acme 為品牌；productType 留空',
    '主圖白底突出布料、近拍補強織紋細節',
  ],
  progressNote: '文案好了，老闆看一下',
};

const submitListingResponse = {
  content: '',
  tool_calls: [{ name: 'submit_listing', id: 'call_submit_listing', args: listingFixture }],
};
const toolPassInvokeMock = vi.fn();
toolPassInvokeMock.mockResolvedValue(submitListingResponse);
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
  })),
}));

const generateToolInvoke = vi.fn(async () => ({
  id: 'img-1',
  url: 'https://cdn.example.com/img-1.jpg',
}));

vi.mock('../src/integrations/openai-images/tools.js', () => ({
  IMAGE_TOOL_IDS: ['images.generate', 'images.edit'],
  buildImageTools: vi.fn(() => [
    {
      id: 'images.generate',
      tool: { name: 'images_generate', invoke: generateToolInvoke },
    },
  ]),
}));

vi.mock('../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'test-access-key',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'test-secret-key',
    CLOUDFLARE_R2_BUCKET: 'test-bucket',
    CLOUDFLARE_R2_PUBLIC_BASE_URL: 'https://cdn.example.com',
    OPENAI_API_KEY: 'test-openai-key',
  },
}));

vi.mock('../src/integrations/cloudflare/images-client.js', () => ({
  CloudflareImagesClient: vi.fn(() => ({})),
}));
vi.mock('../src/integrations/openai-images/client.js', () => ({
  OpenAIImagesClient: vi.fn(() => ({})),
}));
vi.mock('../src/integrations/cloudflare/images-repository.js', () => ({
  insertImage: vi.fn(async () => ({ id: 'row-1' })),
  getImageById: vi.fn(async () => null),
}));

vi.mock('../src/agents/skill-packs-repository.js', () => ({
  listPacksForAgent: vi.fn(async () => []),
}));

const { productDesignerAgent } = await import('../src/agents/builtin/product-designer/index.js');

const publisherPeer = {
  id: 'shopify-publisher',
  name: 'Shopify Publisher',
  description: 'Publishes to Shopify',
  metadata: { kind: 'publisher' },
};

const briefMarkdown = `### Marketing angle
機能透氣，台灣濕熱夏天通勤族 — 切「機能 + 在地實穿」。

### Key messages
- 不悶熱
- 可機洗

### Copy brief
**Tone**: warm, professional
**Features to highlight**: fabric

### Image plan
- **Hero (required)** white background, hero shot
`;

function buildCtx(overrides = {}) {
  return {
    tenantId: 't1',
    taskId: 'task-1',
    modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.3 },
    systemPrompt: 'You are a product designer.',
    agentConfig: {},
    availableExecutionAgents: [publisherPeer],
    tenantProfile: {
      profileMd: '',
      timezone: 'UTC',
      imageStyleSuffix: '',
      imageStyleReferenceImageIds: [],
    },
    logCtx: { taskId: 'task-1', agentId: 'product-designer' },
    emitLog: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('product-designer', () => {
  it('spawns shopify-publisher with ProductContent on first run', async () => {
    toolPassInvokeMock.mockResolvedValue(submitListingResponse);

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: briefMarkdown }],
      params: { brief: briefMarkdown, refs: { language: 'zh-TW' } },
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.spawnTasks).toHaveLength(1);
    expect(output.spawnTasks![0]!.assignedAgent).toBe('shopify-publisher');
    const content = output.spawnTasks![0]!.input.content as ProductContent;
    expect(content.refs.title).toBe('Linen Oversized Shirt');
    expect(content.body).toContain('180g 亞麻');
    expect(content.refs.language).toBe('zh-TW');
    // Post-PR6: content.report is body+images string (was boss prose).
    // Type contract preserved so un-migrated publisher keeps working.
    expect(typeof content.report).toBe('string');
    expect(content.report).toContain('180g 亞麻');
  });

  it('preserves previous imageUrls when feedback does not trigger image generation', async () => {
    toolPassInvokeMock.mockResolvedValue(submitListingResponse);

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [
        { role: 'user', content: briefMarkdown },
        { role: 'assistant', content: 'draft' },
        { role: 'user', content: 'copy tone is too formal' },
      ],
      params: { brief: briefMarkdown, refs: { language: 'zh-TW' } },
      taskOutput: {
        payload: { content: { refs: { imageUrls: ['https://cdn.example.com/prev.jpg'] } } },
      },
    });

    const content = output.spawnTasks![0]!.input.content as ProductContent;
    expect(content.refs.imageUrls).toEqual(['https://cdn.example.com/prev.jpg']);
  });

  it('replaces imageUrls when LLM generates new images on feedback', async () => {
    let hop = 0;
    toolPassInvokeMock.mockImplementation(async () => {
      if (hop === 0) {
        hop++;
        return {
          content: '',
          tool_calls: [
            { name: 'images_generate', id: 'call-1', args: { prompt: 'new background' } },
          ],
        };
      }
      return submitListingResponse;
    });

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'change background to dark wood' }],
      params: { brief: briefMarkdown, refs: { language: 'zh-TW' } },
      taskOutput: {
        payload: { content: { refs: { imageUrls: ['https://cdn.example.com/prev.jpg'] } } },
      },
    });

    const content = output.spawnTasks![0]!.input.content as ProductContent;
    expect(content.refs.imageUrls).toEqual(['https://cdn.example.com/img-1.jpg']);

    // Post-PR6: image markdown rides on artifact.body (was artifact.report).
    const artifact = output.artifact as { body: string };
    expect(artifact.body).toContain('## 生成的圖片');
    expect(artifact.body).toContain('![圖 1](https://cdn.example.com/img-1.jpg)');

    toolPassInvokeMock.mockResolvedValue(submitListingResponse);
    hop = 0;
  });

  it('emits Artifact{body, refs} (no agent-written report) and surfaces images on body', async () => {
    toolPassInvokeMock.mockResolvedValue(submitListingResponse);
    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: briefMarkdown }],
      params: { brief: briefMarkdown, refs: { language: 'zh-TW' } },
    });
    const artifact = output.artifact;
    // The agent no longer writes report — that's report-writer's job now.
    expect(artifact).not.toHaveProperty('report');
    expect(artifact).toHaveProperty('body');
    expect(artifact).toHaveProperty('refs');
    expect(artifact).not.toHaveProperty('kind');
    expect(artifact).not.toHaveProperty('data');
    if (artifact && 'refs' in artifact) {
      expect(artifact.refs).toMatchObject({
        title: 'Linen Oversized Shirt',
        language: 'zh-TW',
        imageUrls: expect.any(Array),
      });
    }
  });

  it('surfaces structuredOutput on the inter-node bus for report-writer', async () => {
    toolPassInvokeMock.mockResolvedValue(submitListingResponse);
    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: briefMarkdown }],
      params: { brief: briefMarkdown, refs: { language: 'zh-TW' } },
    });

    expect(output.structuredOutput?.schemaName).toBe('product-listing');
    expect(output.structuredOutput?.data).toMatchObject({
      title: 'Linen Oversized Shirt',
      body: expect.stringContaining('180g 亞麻'),
      tags: ['linen', 'summer', 'oversized'],
      vendor: 'Acme',
      language: 'zh-TW',
      imageUrls: expect.any(Array),
    });
    expect(output.structuredOutput?.keyDecisions).toEqual(listingFixture.keyDecisions);
  });
});
```

**Step 2: Don't run RED — go straight to GREEN.**

---

### Task 2: Migrate the agent (GREEN)

**Files:**
- Modify: `src/agents/builtin/product-designer/index.ts`

**What:** Five coordinated edits:
1. **DEFAULT_PROMPT:** drop the `report` instruction; add a paragraph about `keyDecisions` + don't-write-boss-prose.
2. **`ProductListingSchema`:** drop `report` field; add `keyDecisions[]`.
3. **Manifest:** add `metadata: { kind: 'execution', shape: 'atomic' }` (currently no metadata block).
4. **`invoke()`:** synthesize image markdown onto `artifact.body` (was on `report`); set `payload.content.report = bodyWithImages` (preserve string for un-migrated publisher); add `structuredOutput` block.
5. **emitLog payload:** `artifactShape: 'body+structuredOutput'` (was `'report+body'`).

**Step 1: DEFAULT_PROMPT**

Find the existing block at lines 19-48. Replace the section starting "After tool calls (or if no tools needed), produce the structured listing object." through end of prompt with:

```
After tool calls (or if no tools needed), produce the structured listing object.
- progressNote is one short sentence for the kanban timeline.
- keyDecisions is 3-5 short bullets the report-writer can lean on when generating
  the boss-facing memo. These are NOT boss-facing prose themselves — keep them
  short and concrete (e.g. "從 brief 推斷 Acme 為品牌", "主圖白底突出布料").
- Do NOT write a boss memo as part of your output. The shared report-writer
  node renders the boss-facing prose from your structured fields at the HITL
  boundary — your job is to produce the deliverable (title/body/tags/etc.) and
  the keyDecisions hints; the rendering is downstream.`;
```

**Step 2: Schema** — find lines 50-84 (`ProductListingSchema`):

Drop the entire `report: z.string().min(80).max(4000).describe(...)` field. Insert `keyDecisions` between `productType` and `progressNote`:

```ts
const ProductListingSchema = z.object({
  title: z.string().min(1).max(255),
  body: z
    .string()
    .min(20)
    .describe(
      'Product description body in Markdown. Use <h3>-equivalent ## / ### subheads, ' +
        '**bold**, *italic*, - bullets, > blockquote. Do NOT emit raw HTML — the publisher ' +
        'converts to HTML at the Shopify Admin API boundary.',
    ),
  tags: z.array(z.string().min(1)).min(1).max(20),
  vendor: z.string().min(1),
  productType: z.string().nullish().catch(null),
  keyDecisions: z
    .array(z.string().min(5))
    .min(1)
    .max(5)
    .describe(
      '3-5 short bullets the downstream report-writer can lean on when generating boss prose. ' +
        'Examples: "機能透氣切台灣通勤實戰", "從 brief 推斷 Acme 為品牌", "主圖白底突出布料". ' +
        'Be concrete about copy angle, vendor inference, and image choices. Not boss-facing prose itself.',
    ),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe('一句話對老闆回報剛完成什麼。用 zh-TW 第一人稱，對話對象是「老闆」。'),
});
```

**Step 3: Manifest** — find lines 94-106 (`manifest` block).

Current manifest has no `metadata` block. Insert after `configSchema` (last field):

```ts
    configSchema,
    metadata: { kind: 'execution', shape: 'atomic' },
  },
```

**Step 4: invoke() return** — find lines 232-269.

Find:

```ts
      // Append generated images to the report so the boss panel renders them inline.
      const imageMarkdown =
        imageUrls.length > 0
          ? `\n\n## 生成的圖片\n\n${imageUrls.map((url, i) => `![圖 ${i + 1}](${url})`).join('\n\n')}`
          : '';
      const reportWithImages = `${listing.report}${imageMarkdown}`;

      const content: ProductContent = {
        report: reportWithImages,
        body: listing.body,
        refs: refsOut,
        progressNote: listing.progressNote,
      };

      const spawnTasks: SpawnTaskRequest[] = publishers.map((p) => ({
        title: `${listing.title} → ${p.name}`,
        assignedAgent: p.id,
        input: { content },
      }));

      await ctx.emitLog('agent.content.ready', listing.progressNote, {
        artifactShape: 'report+body',
        title: listing.title,
        imageCount: imageUrls.length,
        publisherCount: spawnTasks.length,
      });

      return {
        message: listing.progressNote,
        awaitingApproval: true,
        artifact: {
          report: reportWithImages,
          body: listing.body,
          refs: refsOut,
        },
        payload: { content },
        spawnTasks,
      };
    };
```

Replace with:

```ts
      // Image markdown moves from `report` (PR5) to `body` (PR6) so images
      // stay user-visible pre-approval after we hand the boss-prose duty to
      // the shared report-writer node.
      const imageMarkdown =
        imageUrls.length > 0
          ? `\n\n## 生成的圖片\n\n${imageUrls.map((url, i) => `![圖 ${i + 1}](${url})`).join('\n\n')}`
          : '';
      const bodyWithImages = `${listing.body}${imageMarkdown}`;

      // Mid-migration plumbing: ProductContent.report stays a string so the
      // un-migrated shopify-publisher (PR7) keeps copying it to its own
      // artifact.report. The semantic content shifts (body+images instead of
      // boss prose) but the type contract holds. PR7 will rework this when
      // the publisher migrates.
      const content: ProductContent = {
        report: bodyWithImages,
        body: listing.body,
        refs: refsOut,
        progressNote: listing.progressNote,
      };

      const spawnTasks: SpawnTaskRequest[] = publishers.map((p) => ({
        title: `${listing.title} → ${p.name}`,
        assignedAgent: p.id,
        input: { content },
      }));

      await ctx.emitLog('agent.content.ready', listing.progressNote, {
        artifactShape: 'body+structuredOutput',
        title: listing.title,
        imageCount: imageUrls.length,
        publisherCount: spawnTasks.length,
      });

      // NOTE: artifact.report intentionally absent — the shared report-writer
      // node fills it from state.lastStructuredOutput at the HITL boundary.
      return {
        message: listing.progressNote,
        awaitingApproval: true,
        artifact: {
          body: bodyWithImages,
          refs: refsOut,
        },
        payload: { content },
        spawnTasks,
        structuredOutput: {
          schemaName: 'product-listing',
          data: {
            title: listing.title,
            body: listing.body,
            tags: listing.tags,
            vendor: listing.vendor,
            ...(listing.productType ? { productType: listing.productType } : {}),
            language: inputLanguage,
            imageUrls,
          },
          keyDecisions: listing.keyDecisions,
        },
      };
    };
```

**Step 5: Run the unit test**

```bash
pnpm test -- tests/product-designer.test.ts
```

Expected: 5 specs passing (was 4).

**Step 6: Run the full unit suite**

```bash
pnpm test
```

Expected: 209 passing (208 baseline + 1 new structuredOutput spec).

---

### Task 3: Typecheck, lint, commit

```bash
pnpm typecheck    # expect: clean
pnpm lint         # expect: clean (run pnpm lint:fix if formatting)
```

Stage exactly:
- `src/agents/builtin/product-designer/index.ts`
- `tests/product-designer.test.ts`

```bash
git add src/agents/builtin/product-designer/index.ts tests/product-designer.test.ts
git commit -m "$(cat <<'EOF'
feat(product-designer): emit structuredOutput; report-writer renders prose

- Schema: drop `report` field; add `keyDecisions[]`. Other fields
  (title, body, tags, vendor, productType, progressNote) unchanged.
- Invoke: image markdown moves from `report` synthesis → appended to
  `artifact.body`, so images stay user-visible pre-approval. Agent
  emits `structuredOutput` with `schemaName='product-listing'` so the
  shared report-writer node (PR1) renders the boss-facing prose at the
  HITL boundary.
- Mid-migration plumbing for downstream publisher: `payload.content.report`
  stays a string (= `body + imageMarkdown`) so the un-migrated
  shopify-publisher (PR7) keeps copying it to its own artifact.report
  without breakage. The semantic content shifts (body+images instead of
  boss prose) but the type contract holds. PR7 will rework this.
- Manifest: tag as `{ kind: 'execution', shape: 'atomic' }` (had no
  metadata block before).
- Prompt: drop the `report` instruction; explicitly tells the LLM not
  to write a boss memo (that's report-writer's job) and explains the
  new `keyDecisions` field.
- Unit test: rewrite fixture (drop `report`, add `keyDecisions`); the
  image-on-report spec now asserts on `artifact.body`; the
  Artifact-shape spec asserts `not.toHaveProperty('report')`; new spec
  asserts the `structuredOutput` bus payload with full data + length.

PR6 of the graph-refactor migration. Mid-migration coexistence holds:
the un-migrated `shopify-publisher` (PR7) still consumes
`payload.content.report` as a string and continues to write its own
`artifact.report`; report-writer no-ops on it (null lastStructuredOutput).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Update both integration tests

PR6 touches **two** integration tests at the designer phase only. Combined into one commit for review ergonomics (same pattern as PR5).

### Task 4: Update `product-publisher.test.ts` + `image-style-e2e.integration.test.ts`

**Files:**
- Modify: `tests/integration/product-publisher.test.ts` (Phase 3 designer phase only)
- Modify: `tests/integration/image-style-e2e.integration.test.ts` (designer phase only)

**What for each file:**
1. Drop `report` from the scripted `submit_listing` args; add `keyDecisions[]`.
2. Add `scriptText(...)` AFTER the `submit_listing` toolCall (supervisor short-circuits on `awaitingApproval=true` per `src/orchestrator/supervisor.ts:69-72`, so NO extra `scriptStructured`).
3. (`product-publisher.test.ts` only): extend the designer-task assertions for the new `artifact.body`/`artifact.report` split + `lastStructuredOutput`. (`image-style-e2e.integration.test.ts` only checks the image generation spy — adding the scriptText is enough; no new artifact assertions needed.)

#### Step 1: `tests/integration/product-publisher.test.ts`

Find the existing block at lines 192-214 (Phase 3: product-designer runs):

```ts
    // ── Phase 3: product-designer runs ───────────────────────────────────────
    // Designer is single-pass: tool-loop with finalAnswer:ProductListingSchema,
    // model submits via submit_listing. No images scripted → no images_generate
    // hop, model goes straight to submit.
    scriptToolCall('submit_listing', {
      title: 'Linen Oversized Shirt',
      body: '## 主特色\n\n輕薄亞麻，台灣夏天通勤首選。\n\n- 不悶熱\n- 可機洗',
      tags: ['linen', 'summer', 'taiwan'],
      vendor: 'Acme',
      report: `## 我的切角

機能透氣切「台灣濕熱通勤」實戰。文案直接連結痛點。

## 為什麼選這個 vendor 跟 productType
從 brief 推斷 Acme 為品牌；productType 留空（brief 未指定）。`,
      progressNote: '文案跟圖片都好了，老闆看一下',
    });

    await drainNextTask();
    const designerTask = await getTask(tenantId, designerTaskId);
    expect(designerTask.status).toBe('waiting');
    expect(designerTask.kind).toBe('strategy');
    expect((designerTask.output as { spawnTasks?: unknown[] })?.spawnTasks).toHaveLength(1);
```

Replace with:

```ts
    // ── Phase 3: product-designer runs ───────────────────────────────────────
    // Designer is single-pass: tool-loop with finalAnswer:ProductListingSchema,
    // model submits via submit_listing. No images scripted → no images_generate
    // hop, model goes straight to submit.
    scriptToolCall('submit_listing', {
      title: 'Linen Oversized Shirt',
      body: '## 主特色\n\n輕薄亞麻，台灣夏天通勤首選。\n\n- 不悶熱\n- 可機洗',
      tags: ['linen', 'summer', 'taiwan'],
      vendor: 'Acme',
      keyDecisions: [
        '機能透氣切「台灣濕熱通勤」實戰',
        '從 brief 推斷 Acme 為品牌；productType 留空',
      ],
      progressNote: '文案跟圖片都好了，老闆看一下',
    });
    // Report-writer LLM call for schemaName='product-listing'. NO extra
    // scriptStructured — supervisor short-circuits on awaitingApproval=true
    // (src/orchestrator/supervisor.ts:69-72).
    scriptText(
      '## 設計決定\n\n機能透氣切台灣濕熱通勤實戰。\n\n## 為什麼這樣選\n\n從 brief 切角直接連結痛點，避免抽象廣告語。',
    );

    await drainNextTask();
    const designerTask = await getTask(tenantId, designerTaskId);
    expect(designerTask.status).toBe('waiting');
    expect(designerTask.kind).toBe('strategy');
    expect((designerTask.output as { spawnTasks?: unknown[] })?.spawnTasks).toHaveLength(1);
    // Post-PR6: designer emits structuredOutput → report-writer renders prose.
    expect(designerTask.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer — prose-unique substring
        // '機能透氣切台灣濕熱通勤實戰' is ONLY in the scripted text above.
        // (The agent's keyDecisions[0] uses the slightly different phrase
        // '機能透氣切「台灣濕熱通勤」實戰' with quote marks — a copy of
        // keyDecisions or body to artifact.report would NOT match the
        // assertion's quote-free substring.)
        report: expect.stringContaining('機能透氣切台灣濕熱通勤實戰'),
        body: expect.stringContaining('## 主特色'),
      },
      lastStructuredOutput: {
        schemaName: 'product-listing',
        data: expect.objectContaining({
          title: 'Linen Oversized Shirt',
          body: expect.stringContaining('## 主特色'),
          tags: expect.arrayContaining(['linen']),
          vendor: 'Acme',
          language: expect.any(String),
        }),
        keyDecisions: expect.arrayContaining(['機能透氣切「台灣濕熱通勤」實戰']),
      },
    });
```

#### Step 2: `tests/integration/image-style-e2e.integration.test.ts`

Find the existing block at lines 99-112:

```ts
    // Script the LLM calls:
    // 1. Supervisor routes to product-designer.
    scriptStructured({ nextAgent: 'product-designer', clarification: null, done: false });
    // 2. Designer's first tool-loop hop: generate an image.
    scriptToolCall('images_generate', { prompt: 'minimalist hero shot of a linen shirt' });
    // 3. Designer's second hop: submit the final listing.
    scriptToolCall('submit_listing', {
      title: 'Linen Shirt',
      body: '## Hero Shot\n\nClean product photography on white background.',
      tags: ['linen', 'shirt', 'summer'],
      vendor: 'Acme',
      report: '## 切角\n\n機能透氣。\n\n## 圖片選擇\n\n白底主圖。',
      progressNote: '圖文都好了，老闆看一下',
    });
```

Replace with:

```ts
    // Script the LLM calls:
    // 1. Supervisor routes to product-designer.
    scriptStructured({ nextAgent: 'product-designer', clarification: null, done: false });
    // 2. Designer's first tool-loop hop: generate an image.
    scriptToolCall('images_generate', { prompt: 'minimalist hero shot of a linen shirt' });
    // 3. Designer's second hop: submit the final listing.
    scriptToolCall('submit_listing', {
      title: 'Linen Shirt',
      body: '## Hero Shot\n\nClean product photography on white background.',
      tags: ['linen', 'shirt', 'summer'],
      vendor: 'Acme',
      keyDecisions: ['機能透氣切角', '白底主圖突出布料'],
      progressNote: '圖文都好了，老闆看一下',
    });
    // 4. Report-writer LLM call for schemaName='product-listing'. NO extra
    // scriptStructured — supervisor short-circuits on awaitingApproval=true
    // (src/orchestrator/supervisor.ts:69-72).
    scriptText('## 設計決定\n\n機能透氣切白底主圖。');
```

#### Step 3: Verify `scriptText` imports

```bash
grep -n "scriptText" tests/integration/product-publisher.test.ts tests/integration/image-style-e2e.integration.test.ts
```

`product-publisher.test.ts` already imports `scriptText` (PR4 added it). `image-style-e2e.integration.test.ts` may or may not — verify and add to its import block if missing:

```ts
import {
  clearScript,
  llmMockModule,
  scriptStructured,
  scriptText,
  scriptToolCall,
} from './helpers/llm-mock.js';
```

#### Step 4: Run targeted tests

```bash
pnpm test:integration -- tests/integration/product-publisher.test.ts
pnpm test:integration -- tests/integration/image-style-e2e.integration.test.ts
```

Each: 1 passing.

Likely failure modes:
- **`task.output.artifact.report` undefined or doesn't contain prose-unique substring** — script-queue ordering wrong. Verify exactly: 1 `scriptStructured` (Phase 1 supervisor route — already there for product-publisher's planner phase + image-style's designer phase) + 1 `scriptToolCall('submit_listing', ...)` + 1 `scriptText(...)` for designer's report-writer. NO post-agent `scriptStructured` in the designer phase.
- **`task.output.artifact.body` undefined or doesn't contain '## 主特色'** — Phase A migration didn't land. Re-run unit test.
- **`lastStructuredOutput.schemaName` undefined** — graph.ts/runner.ts wiring broken (PR1 invariants — should still hold).
- **Schema rejection on `submit_listing`** — you forgot to drop `report` and add `keyDecisions` somewhere.

#### Step 5: Run full integration suite

```bash
pnpm test:integration
```

Expected: 104 passing (no count change).

#### Step 6: Typecheck + lint + commit

```bash
pnpm typecheck
pnpm lint
```

Stage exactly: both modified test files.

```bash
git add tests/integration/product-publisher.test.ts tests/integration/image-style-e2e.integration.test.ts
git commit -m "$(cat <<'EOF'
test(integration): wire designer phase to report-writer + structuredOutput

Update both E2E tests that exercise product-designer:

- product-publisher.test.ts (Phase 3 designer): drop `report` from
  scripted submit_listing args, add `keyDecisions[]`, add `scriptText`
  for designer's report-writer. New designer-task assertions for the
  artifact.body/report split + lastStructuredOutput.schemaName=
  'product-listing'. Publisher phase (Phase 5/6) untouched —
  publisher's artifact.report continues to come from
  payload.content.report (now body+images string instead of boss prose,
  but the type contract holds).
- image-style-e2e.integration.test.ts (designer phase): same drop+add
  on submit_listing args + add scriptText for report-writer. The test's
  main assertion (image generation prompt content) is unchanged.

Both files: NO extra `scriptStructured` between submit_listing and
scriptText — supervisor short-circuits without an LLM call when
`awaitingApproval=true` (src/orchestrator/supervisor.ts:69-72).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Verify and finish

### Task 5: Full suite + finishing-a-development-branch

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
```

Expected:
- typecheck: clean
- lint: clean
- unit: 209 passing (208 baseline + 1 new structuredOutput spec)
- integration: 104 passing (no count change)

Announce: "I'm using the finishing-a-development-branch skill to complete this work."

**REQUIRED SUB-SKILL:** Use `superpowers:finishing-a-development-branch`. Present the 4 standard options. Expected user choice: "Merge to main locally" — when chosen:
1. `git checkout main`
2. `git pull` (no-op or fast-forward depending on push state)
3. `git merge feat/graph-refactor-pr6` (ff expected)
4. Re-run `pnpm test` on merged main as a smoke check
5. `git branch -d feat/graph-refactor-pr6`
6. `git worktree remove .worktrees/graph-refactor-pr6`

**Do NOT push to origin without explicit user confirmation.**

---

## Risks & mitigations

**R1 — Mid-migration `payload.content.report` semantic shift**
The publisher's `artifact.report` stops being boss prose and becomes `body + imageMarkdown` (the agent's body content with images appended). UX on the publisher task page changes: user sees the actual product description with images instead of an analytical summary. **Mitigation:** acceptable mid-migration UX — the user is reviewing the about-to-publish artifact, so seeing the content directly is arguably more useful than a meta-analysis. PR7 will rewire this when shopify-publisher migrates.

**R2 — `ProductContent.report: string` type contract holds**
Publisher's invoke does `artifact: { report: content.report, ... }`. If we accidentally set `content.report = undefined`, the publisher's artifact.report becomes undefined and the existing `expect.any(String)` assertion in `product-publisher.test.ts:241` would FAIL. **Mitigation:** the unit test's first spec explicitly asserts `typeof content.report === 'string'`. The agent code never sets it to undefined.

**R3 — Image markdown placement on body changes UX visibility**
Today users see images via `artifact.report`. After PR6 they see them via `artifact.body`. UI consumers that render artifact.report-as-markdown for the kanban panel will lose images on designer tasks until the UI also reads body. **Mitigation:** the existing UI already renders artifact.body when present (used by article-writer post-PR2). No UI change needed. If a UI panel only reads artifact.report, the report-writer's prose still appears there — just no images embedded.

**R4 — Three test files = larger surface than PR3/PR4/PR5**
PR3 had 1 (new) integration test. PR4 had 1 (existing). PR5 had 2 (existing). PR6 has 2 (existing). All same kind of update; nothing genuinely new. **Mitigation:** Phase B groups them in one commit; the verbatim diffs are in the plan.

**R5 — Future PRs (PR7) read this file as a recipe**
PR7 (shopify-publisher) is a special case — no LLM call, plus a rename to `shopify-product-publisher`. PR6 is NOT a recipe template for PR7. **Mitigation:** the plan calls this out in "Out of scope" below.

**R6 — Prose-unique substring discrimination in product-publisher.test.ts**
The new assertion uses `expect.stringContaining('機能透氣切台灣濕熱通勤實戰')` (no quote marks). The agent's `keyDecisions[0]` uses `'機能透氣切「台灣濕熱通勤」實戰'` (with quote marks) and the body content does not include this exact phrase. So the prose-unique substring genuinely discriminates report-writer prose from a body-or-keyDecisions copy regression. **Verified at plan-write time** by careful character match.

---

## Out of scope (deferred to PR7)

- **`shopify-publisher` migration + rename to `shopify-product-publisher`.** Special case: pure tool-builder, no LLM call. PR7's scope: (a) decide whether publisher emits a "synthetic" structuredOutput from its `pendingToolCall.args` so report-writer can render boss prose for the publisher task, OR (b) leave artifact.report as report-writer's no-op and let the UI fall back to body. Plus the rename touches activation/UI/docs.
- **Removing the `body` / `report` field overlap in the artifact wire format** — addressed in PR10.
- **Pushing to `origin`** — gated on explicit user confirmation per PR1–PR5 convention.
- **PR10 cleanup of "NOTE: artifact.report intentionally absent" comments across all migrated agents** — when the artifact wire format collapses.
