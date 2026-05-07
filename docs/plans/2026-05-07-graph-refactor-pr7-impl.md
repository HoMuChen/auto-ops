# Graph Refactor PR7: Migrate `shopify-publisher` — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the `shopify-publisher` execution agent (consumes designer's `ProductContent`; emits `pendingToolCall` for `shopify.create_product`) to PR1's `lastStructuredOutput` channel — drop the `report` field from `ProductContent` entirely, stop writing `artifact.report` (let report-writer fill it), emit `structuredOutput { schemaName: 'shopify-publish-intent' }` with deterministic `keyDecisions`, and rip out PR6's mid-migration plumbing line in `product-designer`.

**Architecture:**
- `ProductContent` type loses its `report: string` field. Designer drops `payload.content.report = bodyWithImages`. Publisher's deterministic invoke (no LLM call) emits `structuredOutput` so report-writer renders boss prose at the HITL boundary, just like the migrated atomic agents.
- Publisher's `artifact` shape: `{ body: bodyWithImages, refs: { ...content.refs, ready: true } }` — drops `report`. Image markdown is rebuilt locally (3-line inline duplicate of designer's logic; not worth a shared helper for two callsites).
- `pendingToolCall` is unchanged: `shopify.create_product { title, bodyHtml: markdownToHtml(content.body), tags, vendor, productType?, images? }`. The Shopify Admin API takes images via the `images[]` field, NOT inline in `body_html`, so `content.body` (image-free markdown) is the right input for HTML conversion. Image markdown only goes onto `artifact.body` for boss-facing display.
- `manifest.metadata.kind` stays `'publisher'` (designer filters peers by this); add `shape: 'atomic'` for symmetry with the migrated agents.
- New schema name: `'shopify-publish-intent'`. NOT added to `REPORT_SKIP_SCHEMAS` — the boss benefits from a tight "what's about to ship" summary at this gate.
- **Out of scope (deferred):** the design-doc-listed rename `shopify-publisher → shopify-product-publisher`. The rename is purely cosmetic ("symmetry with future blog publisher") and PR9 (split publisher) is "much later". Keeping the agent id stable also avoids invalidating any `agent_configs` / `tasks.assignedAgent` rows in dev DBs. If the user wants the rename folded in, it's a follow-up commit on this branch.
- Three test files touched: `tests/shopify-publisher.test.ts` (unit), `tests/product-designer.test.ts` (must drop the now-stale `content.report` assertions), `tests/integration/product-publisher.test.ts` (E2E publisher phase). `tests/integration/image-style-e2e.integration.test.ts` does NOT reach the publisher phase (only drains the designer task), so no change.

**Tech Stack:** TypeScript, Zod, vitest. House LLM gateway is OpenRouter via `buildModel()`. Test style: `vi.mock` for unit, real Supabase + `llm-mock` (`scriptStructured` + `scriptText` + `scriptToolCall`) for integration.

**Design ref:** `docs/plans/2026-05-07-graph-refactor-design.md` §"PR3–7", §"`report-writer` node". Reference shape: PR6's `product-designer` (`docs/plans/2026-05-07-graph-refactor-pr6-impl.md`). The migration mechanics (drop `report`, add `keyDecisions`, emit `structuredOutput`) are identical; the twist is that the publisher's invoke is **deterministic** (no LLM call), so `keyDecisions` are built in code from the listing fields rather than asked of the model.

---

## Pre-flight

```bash
pnpm typecheck             # expect: clean
pnpm lint                  # expect: clean
pnpm test                  # expect: 213 passed (PR6 baseline)
pnpm test:integration      # expect: 104 passed
```

If baseline isn't green, stop — PR7 lands on a clean main or not at all.

**Worktree setup:** Use `superpowers:using-git-worktrees` to create `.worktrees/graph-refactor-pr7` on branch `feat/graph-refactor-pr7`. Copy `.env` from the primary worktree (`cp /Users/largitdata/project/auto-ops/.env .env`) so integration tests can resolve `DATABASE_URL`.

**Scope sanity check (run from the worktree):**

```bash
grep -rn "shopify-publisher\|shopifyPublisher\|ProductContent\|content\.report" src/ tests/ --include="*.ts"
```

Expected matches (anything else surfaces, stop and re-scope):
- `src/agents/builtin/shopify-publisher/index.ts` — the agent (rewriting in Task 3)
- `src/agents/builtin/shopify-publisher/content.ts` — `ProductContent` type (drop `report` in Task 4)
- `src/agents/index.ts` — bootstrap registration (no change; id stays `shopify-publisher`)
- `src/agents/builtin/product-designer/index.ts` — imports `ProductContent`; has the mid-migration plumbing line `content.report = bodyWithImages` to drop in Task 5
- `tests/shopify-publisher.test.ts` — unit test (rewriting in Task 1)
- `tests/product-designer.test.ts` — has 3 `content.report` assertions (lines 152, 153, 206) that must be deleted/replaced in Task 6
- `tests/integration/product-publisher.test.ts` — E2E (Phase 5 publisher-phase update in Task 8)
- `tests/integration/activation.test.ts` — references `shopify-publisher` in URL paths only (no behavioural dep; **do not touch**)
- `tests/activation.test.ts` — imports `shopifyPublisherAgent` for credential-validation tests (no behavioural dep; **do not touch**)
- `tests/integration/image-style-e2e.integration.test.ts` — designer-only flow (no publisher drain; **do not touch**)

Also confirm there are no other consumers of `payload.content.report`:

```bash
grep -rn "content\.report\|payload\.content\.report" src/ --include="*.ts"
```

Expected: only the designer (the line being deleted). If anything else surfaces, stop and re-scope — that file would also need migration.

---

## Phase A — Migrate the publisher (TDD, single commit)

### Task 1: Rewrite the unit test to assert the new shape (RED)

**Files:**
- Modify: `tests/shopify-publisher.test.ts` — fixture + 4 specs (was 3).

**What:** Three coordinated edits:
1. **Fixture:** drop `report` from `MOCK_CONTENT`.
2. **Existing spec 2 (`'invoke() maps ProductContent to pendingToolCall without calling LLM'`):** drop the `artifact.report: expect.any(String)` assertion. Add `not.toHaveProperty('report')` since report-writer fills it now. Assert `artifact.body` contains image markdown (since images now ride on body, not report). Keep `pendingToolCall` assertion unchanged — Shopify HTML still has no inline images.
3. **NEW spec 4 (`'emits structuredOutput { schemaName: shopify-publish-intent } with deterministic keyDecisions'`):** assert the structured output contract.

**Step 1: Replace the file**

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ProductContent } from '../src/agents/builtin/shopify-publisher/content.js';

/**
 * shopify-publisher (post-PR7): execution agent that converts a ProductContent
 * into a Shopify create_product pendingToolCall. Invoke is deterministic
 * (no LLM call) so keyDecisions are built from the listing fields in code.
 *
 * Post-PR7 contract:
 * - `artifact.body` = content.body + image markdown (boss-facing display).
 * - `artifact.report` is filled by report-writer, NOT by the agent.
 * - `pendingToolCall.args.bodyHtml` = markdownToHtml(content.body) — image-free,
 *   because Shopify takes images via the `images[]` field, not inline in HTML.
 * - `structuredOutput.schemaName='shopify-publish-intent'` — report-writer
 *   renders a tight "I'm about to ship" summary at the HITL boundary.
 * - `ProductContent` no longer has a `report` field; designer's mid-migration
 *   plumbing is gone.
 */

vi.mock('../src/integrations/shopify/tools.js', () => ({
  SHOPIFY_TOOL_IDS: ['shopify.create_product'],
  buildShopifyTools: vi.fn(async () => [
    {
      id: 'shopify.create_product',
      tool: { invoke: vi.fn(async () => ({ productId: 'gid://shopify/Product/1' })) },
    },
  ]),
}));

const { shopifyPublisherAgent } = await import('../src/agents/builtin/shopify-publisher/index.js');

const MOCK_CONTENT: ProductContent = {
  body: '## 主特色\n\n- 180g 亞麻\n- 可機洗',
  refs: {
    title: 'Linen Oversized Shirt',
    tags: ['linen', 'summer', 'oversize'],
    vendor: 'Acme',
    language: 'zh-TW',
    imageUrls: ['https://media.autoffice.app/img-1.png'],
  },
  progressNote: '商品文案好了',
};

describe('shopify-publisher', () => {
  it('has metadata.kind = publisher and shape = atomic', () => {
    expect(shopifyPublisherAgent.manifest.metadata?.kind).toBe('publisher');
    expect(shopifyPublisherAgent.manifest.metadata?.shape).toBe('atomic');
  });

  it('invoke() maps ProductContent to pendingToolCall + body+images artifact (no agent-written report)', async () => {
    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: { shopify: { autoPublish: false } },
      availableExecutionAgents: [],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'shopify-publisher' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { content: MOCK_CONTENT },
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.pendingToolCall).toMatchObject({
      id: 'shopify.create_product',
      args: {
        title: 'Linen Oversized Shirt',
        // body is markdown; publisher converts via markdownToHtml at the boundary.
        // Image markdown is NOT inline — Shopify takes images via `images[]`.
        bodyHtml: expect.stringContaining('<h2>主特色</h2>'),
        tags: expect.arrayContaining(['linen']),
        vendor: 'Acme',
        images: [{ url: 'https://media.autoffice.app/img-1.png' }],
      },
    });
    expect(output.pendingToolCall?.args.bodyHtml).not.toContain('<img');

    const artifact = output.artifact;
    expect(artifact).toBeDefined();
    // Post-PR7: agent no longer writes report — that's report-writer's job.
    expect(artifact).not.toHaveProperty('report');
    expect(artifact).toMatchObject({
      // bodyWithImages: image markdown appended so the boss sees images
      // alongside the description in the artifact panel.
      body: expect.stringContaining('## 主特色'),
      refs: expect.objectContaining({
        title: 'Linen Oversized Shirt',
        vendor: 'Acme',
        imageUrls: ['https://media.autoffice.app/img-1.png'],
        ready: true,
      }),
    });
    expect((artifact as { body: string }).body).toContain(
      '![圖 1](https://media.autoffice.app/img-1.png)',
    );
    expect(artifact).not.toHaveProperty('kind');
    expect(artifact).not.toHaveProperty('data');
  });

  it('invoke() omits images key when imageUrls is empty (and body has no image markdown)', async () => {
    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: {},
      availableExecutionAgents: [],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'shopify-publisher' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { content: { ...MOCK_CONTENT, refs: { ...MOCK_CONTENT.refs, imageUrls: [] } } },
    });

    expect(output.pendingToolCall?.args).not.toHaveProperty('images');
    // No images → no image markdown on artifact.body either.
    const artifact = output.artifact as { body: string };
    expect(artifact.body).not.toContain('## 生成的圖片');
    expect(artifact.body).not.toMatch(/!\[圖 \d+\]/);
  });

  it('emits structuredOutput { schemaName: shopify-publish-intent } with deterministic keyDecisions', async () => {
    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-3',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: {},
      availableExecutionAgents: [],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-3', agentId: 'shopify-publisher' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { content: MOCK_CONTENT },
    });

    expect(output.structuredOutput?.schemaName).toBe('shopify-publish-intent');
    expect(output.structuredOutput?.data).toMatchObject({
      title: 'Linen Oversized Shirt',
      vendor: 'Acme',
      tags: ['linen', 'summer', 'oversize'],
      language: 'zh-TW',
      imageCount: 1,
      imageUrls: ['https://media.autoffice.app/img-1.png'],
    });
    // productType is optional (not set on MOCK_CONTENT) — must NOT appear in
    // data, even as null/undefined, so the report-writer prompt stays clean.
    expect(output.structuredOutput?.data).not.toHaveProperty('productType');

    const decisions = output.structuredOutput?.keyDecisions ?? [];
    expect(decisions).toHaveLength(3);
    // First bullet names the title + platform — anchors the boss summary.
    expect(decisions[0]).toContain('Linen Oversized Shirt');
    expect(decisions[0]).toContain('Shopify');
    // Second bullet names the vendor.
    expect(decisions[1]).toContain('Acme');
    // Third bullet has the inventory metrics.
    expect(decisions[2]).toMatch(/3 個標籤/);
    expect(decisions[2]).toMatch(/1 張圖片/);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
pnpm test -- tests/shopify-publisher.test.ts
```

Expected: 4 specs, **multiple failures** — at minimum:
- "has metadata.kind = publisher and shape = atomic" → fails (`metadata.shape` not yet set)
- "invoke() maps ProductContent ..." → fails (`artifact.report` still present, `artifact.body` doesn't contain image markdown)
- "invoke() omits images key ..." → may pass on the existing code; the new image-markdown assertions fail.
- "emits structuredOutput ..." → fails (no structuredOutput emitted yet)

This is intentional — the failing tests gate the agent rewrite below.

---

### Task 2: Drop `report` from `ProductContent`

**Files:**
- Modify: `src/agents/builtin/shopify-publisher/content.ts`

**Step 1: Replace the file**

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
  /** Product description body in Markdown — image-free. Converted to HTML at
   *  the publish boundary by the publisher (markdownToHtml). Image markdown
   *  is rebuilt by display callers from refs.imageUrls. */
  body: string;
  refs: {
    title: string;
    tags: string[];
    vendor: string;
    productType?: string;
    language: string;
    /** CF Images public URLs — already uploaded, ready for platform APIs. */
    imageUrls: string[];
  };
  /** First-person progress note shown on the kanban timeline. Not part of
   *  the artifact wire format — used as the spawn child's initial message
   *  and the parent's emitLog message. */
  progressNote: string;
}
```

**Step 2: Run typecheck to surface every consumer**

```bash
pnpm typecheck
```

Expected: type errors at:
- `src/agents/builtin/product-designer/index.ts` — `content.report` assignment is a type error.
- `src/agents/builtin/shopify-publisher/index.ts` — `content.report` read is a type error.

These are the exact lines the next two tasks delete.

---

### Task 3: Rewrite the publisher agent

**Files:**
- Modify: `src/agents/builtin/shopify-publisher/index.ts`

**What:** Replace `invoke()` body so it: (a) builds `bodyWithImages` for `artifact.body`, (b) drops `artifact.report`, (c) emits `structuredOutput`, (d) preserves the existing `pendingToolCall` shape exactly. Also extend `manifest.metadata` with `shape: 'atomic'`.

**Step 1: Replace the file**

```ts
import { z } from 'zod';
import { SHOPIFY_TOOL_IDS, buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { markdownToHtml } from '../../lib/markdown.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';
import type { ProductContent } from './content.js';

const configSchema = z.object({
  shopify: z
    .object({
      credentialLabel: z.string().nullish(),
      autoPublish: z.boolean().default(false),
    })
    .default({}),
});

type ShopifyPublisherConfig = z.infer<typeof configSchema>;

export const shopifyPublisherAgent: IAgent = {
  manifest: {
    id: 'shopify-publisher',
    name: 'Shopify 商品發布員',
    description:
      '把現成的 ProductContent 包上架到租戶的 Shopify 商店；' +
      '預期 task.input.params.content 為 ProductContent 物件。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0 },
    defaultPrompt: '',
    toolIds: SHOPIFY_TOOL_IDS,
    requiredCredentials: [
      {
        provider: 'shopify',
        description: 'Shopify Admin API token + store URL — needed to create products',
        setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
      },
    ],
    configSchema,
    metadata: { kind: 'publisher', shape: 'atomic' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ShopifyPublisherConfig;
    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.shopify.credentialLabel ? { credentialLabel: cfg.shopify.credentialLabel } : {}),
      autoPublish: cfg.shopify.autoPublish,
    });
    const filtered = tools.filter((t) => t.id === 'shopify.create_product');

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      const content = input.params.content as ProductContent;
      const { title, tags, vendor, productType, language, imageUrls } = content.refs;
      const bodyHtml = markdownToHtml(content.body);

      await ctx.emitLog('agent.started', content.progressNote, {
        title,
        imageCount: imageUrls.length,
      });

      const pendingToolCall = {
        id: 'shopify.create_product',
        args: {
          title,
          bodyHtml,
          tags,
          vendor,
          ...(productType ? { productType } : {}),
          ...(imageUrls.length > 0 ? { images: imageUrls.map((url) => ({ url })) } : {}),
        },
      };

      // Image markdown for boss-facing display only — Shopify gets images via
      // the `images[]` field, not inline in body_html. Same shape as the
      // designer's bodyWithImages; inlined here rather than shared because the
      // logic is 3 lines and only used in two callsites (PR7 plan §"Architecture").
      const imageMarkdown =
        imageUrls.length > 0
          ? `\n\n## 生成的圖片\n\n${imageUrls.map((url, i) => `![圖 ${i + 1}](${url})`).join('\n\n')}`
          : '';
      const bodyWithImages = `${content.body}${imageMarkdown}`;

      // NOTE: artifact.report intentionally absent — the shared report-writer
      // node fills it from state.lastStructuredOutput at the HITL boundary.
      return {
        message: content.progressNote,
        awaitingApproval: true,
        artifact: {
          body: bodyWithImages,
          refs: { ...content.refs, ready: true },
        },
        payload: { content },
        pendingToolCall,
        structuredOutput: {
          schemaName: 'shopify-publish-intent',
          data: {
            title,
            vendor,
            tags,
            language,
            ...(productType ? { productType } : {}),
            imageCount: imageUrls.length,
            imageUrls,
          },
          // Deterministic — no LLM call. Three concrete bullets the
          // report-writer leans on to render boss prose.
          keyDecisions: [
            `準備上架「${title}」到 Shopify (${language})`,
            `品牌 ${vendor}${productType ? ` / ${productType}` : ''}`,
            `${tags.length} 個標籤、${imageUrls.length} 張圖片`,
          ],
        },
      };
    };

    return { tools: filtered, invoke };
  },
};
```

**Step 2: Run the unit test to verify it passes**

```bash
pnpm test -- tests/shopify-publisher.test.ts
```

Expected: **4 passed**.

If any spec still fails, fix forward — the test is the spec.

---

### Task 4: Drop the mid-migration plumbing line in `product-designer`

**Files:**
- Modify: `src/agents/builtin/product-designer/index.ts`

**What:** Two coordinated edits in `invoke()`:
1. Drop the `report: bodyWithImages` field from the `content` object literal (was the PR6 mid-migration plumbing).
2. Delete the long comment block above it that explained the plumbing (lines roughly 243–250 in the current file). Replace with a single line documenting the post-PR7 shape.

**Step 1: Find the block to replace**

Use Edit. The current block is:

```ts
      // Mid-migration plumbing: ProductContent.report stays a string so the
      // un-migrated shopify-publisher (PR7) keeps copying it to its own
      // artifact.report. The semantic content shifts (body+images instead of
      // boss prose) but the type contract holds. PR7 will rework this:
      // publisher should drop the field from ProductContent entirely and
      // read body+images from `lastStructuredOutput.data.{body,imageUrls}`
      // instead, so report-writer (not the upstream agent) controls the
      // publisher's artifact.report.
      const content: ProductContent = {
        report: bodyWithImages,
        body: listing.body,
        refs: refsOut,
        progressNote: listing.progressNote,
      };
```

**Step 2: Replace with**

```ts
      // ProductContent carries machine-readable fields only. The publisher
      // rebuilds bodyWithImages locally for its own artifact.body display,
      // and emits its own structuredOutput so report-writer fills its
      // artifact.report — designer no longer pre-renders any of it.
      const content: ProductContent = {
        body: listing.body,
        refs: refsOut,
        progressNote: listing.progressNote,
      };
```

**Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: clean.

---

### Task 5: Update `tests/product-designer.test.ts` to match the post-PR7 shape

**Files:**
- Modify: `tests/product-designer.test.ts`

**What:** Three coordinated edits to drop assertions that referenced the now-deleted `content.report`:
1. Update the file-header doc comment — remove the "`payload.content.report` = body + imageMarkdown" line.
2. Spec 1 (`'spawns shopify-publisher with ProductContent on first run'`): delete lines 150–153 (the `typeof content.report === 'string'` + `'180g 亞麻'` assertions on `content.report`). Replace with an assertion that `content` does NOT have a `report` field.
3. Spec 3 (`'replaces imageUrls when LLM generates new images on feedback'`): delete lines 202–206 (the comment block + `expect(content.report).toContain('![圖 1]...')` assertion). The lock for image markdown still rides on `artifact.body` (assertion already present at line 211).

**Step 1: Edit the file-header comment**

Find:

```ts
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
```

Replace with:

```ts
/**
 * product-designer (post-PR7): execution agent that receives a markdown
 * brief from product-planner, generates images via tool loop, writes
 * copy, then spawns publisher tasks.
 *
 * Post-PR7 contract:
 * - `artifact.body` = listing.body + image markdown (images stay user-visible
 *   pre-approval).
 * - `artifact.report` is filled by report-writer, NOT by the agent.
 * - `payload.content` is plain ProductContent (no `report` field) — the
 *   downstream publisher reads body+refs and emits its own structuredOutput.
 * - `structuredOutput.schemaName='product-listing'` carries the deliverable
 *   for report-writer + downstream consumers.
 */
```

**Step 2: Update spec 1**

Find:

```ts
    expect(content.refs.language).toBe('zh-TW');
    // Post-PR6: content.report is body+images string (was boss prose).
    // Type contract preserved so un-migrated publisher keeps working.
    expect(typeof content.report).toBe('string');
    expect(content.report).toContain('180g 亞麻');
  });
```

Replace with:

```ts
    expect(content.refs.language).toBe('zh-TW');
    // Post-PR7: ProductContent no longer carries `report`. The publisher
    // emits its own structuredOutput so report-writer fills its
    // artifact.report independently.
    expect(content).not.toHaveProperty('report');
  });
```

**Step 3: Update spec 3**

Find:

```ts
    const content = output.spawnTasks![0]!.input.content as ProductContent;
    expect(content.refs.imageUrls).toEqual(['https://cdn.example.com/img-1.jpg']);
    // Lock the bodyWithImages mid-migration plumbing: content.report (passed
    // to the un-migrated publisher) must include image markdown, not just
    // the raw body. A regression where someone sets `content.report =
    // listing.body` would silently strip images from the publisher's view.
    expect(content.report).toContain('![圖 1](https://cdn.example.com/img-1.jpg)');

    // Post-PR6: image markdown rides on artifact.body (was artifact.report).
    const artifact = output.artifact as { body: string };
```

Replace with:

```ts
    const content = output.spawnTasks![0]!.input.content as ProductContent;
    expect(content.refs.imageUrls).toEqual(['https://cdn.example.com/img-1.jpg']);
    // Post-PR7: image markdown rides on artifact.body only. content carries
    // raw fields; the publisher rebuilds bodyWithImages from refs.imageUrls.
    const artifact = output.artifact as { body: string };
```

**Step 4: Run the designer unit test**

```bash
pnpm test -- tests/product-designer.test.ts
```

Expected: **5 passed** (same count as before — count didn't change, only assertions did).

---

### Task 6: Verify both unit suites green

**Step 1: Run the full unit suite**

```bash
pnpm test
```

Expected: **213 passed** (same as PR6 baseline — Phase A doesn't change the count).

If unrelated specs fail, stop and triage — likely a leak between mocked modules.

**Step 2: Run lint**

```bash
pnpm lint
```

Expected: clean. Biome may flag the unused `productType` from `content.refs.productType` if it's destructured but unused — current refactor still uses it both for `pendingToolCall.args` and `keyDecisions`, so this should not happen.

**Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: clean.

---

### Task 7: Commit Phase A

```bash
git add \
  src/agents/builtin/shopify-publisher/index.ts \
  src/agents/builtin/shopify-publisher/content.ts \
  src/agents/builtin/product-designer/index.ts \
  tests/shopify-publisher.test.ts \
  tests/product-designer.test.ts

git commit -m "$(cat <<'EOF'
feat(shopify-publisher): emit structuredOutput; report-writer renders prose

Migrate the last execution agent in the PR3-7 series to PR1's
lastStructuredOutput channel. Drop `report` from ProductContent entirely,
let report-writer fill artifact.report, and rip out PR6's mid-migration
plumbing line in product-designer.

The publisher's invoke is deterministic (no LLM call) so keyDecisions
are built in code from the listing fields rather than asked of the model.
schemaName='shopify-publish-intent' — NOT in REPORT_SKIP_SCHEMAS, so the
boss gets a tight "what's about to ship" summary at the publish gate.

Image markdown still rides on artifact.body for boss-facing display;
the Shopify create_product call stays image-free in body_html (images
go via the `images[]` field per the Admin API).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Wire the integration test (TDD, single commit)

### Task 8: Update `tests/integration/product-publisher.test.ts` Phase 5 (publisher phase)

**Files:**
- Modify: `tests/integration/product-publisher.test.ts`

**What:** The publisher phase currently script-free — its `invoke` is deterministic. Post-PR7 the publisher emits structuredOutput, so report-writer fires for `schemaName='shopify-publish-intent'` BEFORE the kanban shows `waiting`. Need to add ONE `scriptText(...)` call for that report-writer LLM hop, plus extend the assertions on the publisher task to check the new artifact + structuredOutput shape.

The Phase 5 comment block needs an update: the publisher now does have a (one-shot) report-writer LLM call.

**Step 1: Find Phase 5**

The current block is:

```ts
    // ── Phase 5: shopify-publisher runs → waiting with pendingToolCall ─────────
    // Publisher agent sets up pendingToolCall only — no Shopify API call until approve.
    await drainNextTask();
    const pubTask = await getTask(tenantId, publisherTaskId);
    expect(pubTask.status).toBe('waiting');
    expect((pubTask.output as { pendingToolCall?: { id: string } })?.pendingToolCall?.id).toBe(
      'shopify.create_product',
    );
```

**Step 2: Replace with**

```ts
    // ── Phase 5: shopify-publisher runs → waiting with pendingToolCall ─────────
    // Publisher agent sets up pendingToolCall (no Shopify API call until approve)
    // AND emits structuredOutput { schemaName: 'shopify-publish-intent' } →
    // report-writer fires once before the HITL gate. NO scriptStructured
    // because supervisor short-circuits on awaitingApproval=true
    // (src/orchestrator/supervisor.ts:69-72).
    scriptText(
      '## 上架前確認\n\n老闆，我把【Linen Oversized Shirt】整理好了，準備丟到 Shopify zh-TW 站。\n\n## 為什麼這樣選\n\n品牌 Acme，3 個標籤、1 張圖片，等你按確認就上線。',
    );

    await drainNextTask();
    const pubTask = await getTask(tenantId, publisherTaskId);
    expect(pubTask.status).toBe('waiting');
    expect((pubTask.output as { pendingToolCall?: { id: string } })?.pendingToolCall?.id).toBe(
      'shopify.create_product',
    );
    // Post-PR7: publisher emits structuredOutput → report-writer renders prose.
    expect(pubTask.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer — prose-unique substring
        // '上架前確認' is ONLY in the scripted text above; the agent's
        // keyDecisions never use that phrase, so a copy of keyDecisions to
        // artifact.report would NOT match this assertion.
        report: expect.stringContaining('上架前確認'),
        body: expect.stringContaining('## 主特色'),
        refs: expect.objectContaining({
          title: 'Linen Oversized Shirt',
          ready: true,
        }),
      },
      lastStructuredOutput: {
        schemaName: 'shopify-publish-intent',
        data: expect.objectContaining({
          title: 'Linen Oversized Shirt',
          vendor: 'Acme',
          tags: expect.arrayContaining(['linen']),
          language: 'zh-TW',
          imageCount: expect.any(Number),
        }),
        keyDecisions: expect.arrayContaining([expect.stringContaining('Linen Oversized Shirt')]),
      },
    });
    // bodyWithImages: image markdown is on artifact.body for the boss view.
    expect((pubTask.output as { artifact: { body: string } }).artifact.body).toMatch(
      /!\[圖 \d+\]/,
    );
```

**Step 3: Run the integration test**

```bash
pnpm test:integration
```

Expected: **104 passed** (same baseline — count didn't change, just assertions deepened).

> **Note:** the vitest positional file filter does NOT actually filter in this project's config — `pnpm test:integration -- file.test.ts` runs the full suite. Skip the file-targeted run; just run the full suite once.

If unrelated specs fail, stop and triage. Most likely cause: a stray `scriptStructured` left over in another test polluting the queue (none expected from PR7's scope).

---

### Task 9: Commit Phase B

```bash
git add tests/integration/product-publisher.test.ts

git commit -m "$(cat <<'EOF'
test(integration): wire publisher phase to report-writer + structuredOutput

Phase 5 of the planner→designer→publisher E2E now covers PR7's
post-migration shape: publisher emits structuredOutput { schemaName:
'shopify-publish-intent' } → report-writer fires → boss prose lands on
artifact.report. Asserts the prose-unique substring '上架前確認' to
discriminate against silent fallbacks (the agent's keyDecisions never
use that phrase).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Verify

### Task 10: Run full test suites

```bash
pnpm test                    # expect: 213 passed
pnpm test:integration        # expect: 104 passed
pnpm typecheck               # expect: clean
pnpm lint                    # expect: clean
```

If everything green: PR7 complete.

### Task 11: Hand off to finishing-a-development-branch

Announce: "I'm using the finishing-a-development-branch skill to complete this work."

Use `superpowers:finishing-a-development-branch` to present merge / PR / keep / discard options. The plan author's expectation (matching PR3-6 cadence) is **option 1: merge to main locally**, not a GitHub PR — the user has been batching pushes manually after each landed PR.

---

## Verification matrix

| Check | Command | Expected |
|---|---|---|
| Unit suite | `pnpm test` | 213 passed |
| Integration suite | `pnpm test:integration` | 104 passed |
| Type check | `pnpm typecheck` | clean |
| Lint | `pnpm lint` | clean |
| `content.report` is fully gone | `grep -rn "content\.report\|payload\.content\.report" src/ tests/ --include="*.ts"` | no matches |
| Designer plumbing comment is gone | `grep -rn "Mid-migration plumbing" src/agents/builtin/product-designer/` | no matches |
| Publisher metadata.shape | `grep -n "shape:" src/agents/builtin/shopify-publisher/index.ts` | `shape: 'atomic'` |

---

## Risks + Mitigations

**R1 — Image markdown duplicated between designer and publisher**
The 3-line `imageMarkdown` block now lives in two files. If we ever change the heading text (`## 生成的圖片`) or numbering, both must update.
**Mitigation:** none — DRY isn't worth the abstraction for two callsites of trivial code (per CLAUDE.md "Three similar lines is better than a premature abstraction"). If a third caller appears, extract to `src/agents/lib/markdown.ts`.

**R2 — Publisher reads `content.report` from a stale checkpoint**
Existing in-progress tasks may have `task.input.content` rows where the designer wrote `content.report` (PR6 shape) before this PR landed. The publisher invoke now ignores it — that's fine; no read of `content.report` exists post-Task 3. Type-wise the field is just an extra unknown property, not an error.
**Mitigation:** none required — additive on read, no shape narrowing breaks consumers.

**R3 — Report-writer LLM mock missing scriptText for the publisher hop**
If a third party adds a future test that walks publisher-to-completion without scripting the report-writer text, the LLM mock will throw. The product-publisher integration test is the only walker today, and Task 8 wires it.
**Mitigation:** the script-queue empty error is loud; debugging is fast.

**R4 — Renaming the agent id later breaks data**
If PR9 (or a follow-up) renames `shopify-publisher → shopify-product-publisher`, any persisted `agent_configs.agent_id`, `tasks.assigned_agent`, etc. break. Out of scope for PR7 (deferred per top-of-plan §"Architecture") but worth flagging in the PR9 plan.
**Mitigation:** PR9 will need a migration script — not a PR7 concern.

---

## What this PR does NOT do (out of scope)

- Rename `shopify-publisher` → `shopify-product-publisher` (deferred to PR9)
- Touch `article-writer` / `seo-article-with-eeat` (separate publisher in PR9)
- Add a `report-writer` skip for `'shopify-publish-intent'` (the boss benefits from the summary; no UX reason to skip)
- Extract a shared `buildBodyWithImages` helper (two callsites; not worth abstracting)
- Wire the publisher's structuredOutput into `tool-executor.ts` post-publish stamping (the existing `refs.published = result` stamp is independent of structuredOutput; PR10 cleanup territory)
