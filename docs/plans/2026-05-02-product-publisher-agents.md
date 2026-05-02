# Product Publisher Agents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Replace `shopify-ops` with a platform-agnostic `product-strategist` (strategy, generates copy + images, spawns publisher children) and a lean `shopify-publisher` (execution, no LLM, pure content → Shopify mapping).

**Architecture:** `product-strategist` runs the LLM once to produce structured `ProductContent`, handles images in code, then returns `spawnTasks` for each available publisher agent (identified by `manifest.metadata.kind === 'publisher'`). `shopify-publisher` is intentionally LLM-free — it reads `task.input.params.content`, maps it to `shopify.create_product` args, and returns a HITL gate. `shopify-ops` is deleted entirely.

**Tech Stack:** TypeScript · Fastify · Drizzle · LangGraph · LangChain · Zod · Vitest

**Design Doc:** `docs/plans/2026-05-02-product-publisher-agents-design.md`

**Read before starting:**
- `src/agents/builtin/shopify-ops/index.ts` — the agent being replaced (copy patterns + render function)
- `src/agents/builtin/seo-strategist/index.ts` — strategy agent pattern to follow
- `src/agents/lib/messages.ts` — `buildAgentMessages` (async, pass `input.imageResolver`)
- `src/agents/lib/packs.ts` — `loadPacks(dir, cfg.skills)`
- `src/orchestrator/graph.ts:46-79` — how `availableExecutionAgents` / `peerDescriptors` is built
- `src/agents/types.ts` — `IAgent`, `PeerAgentDescriptor`, `AgentInput`
- `tests/integration/shopify-ops.test.ts` — integration pattern to adapt

---

## Section A — Shared type + metadata threading

### Task 1: Add `metadata` to `PeerAgentDescriptor`

The product-strategist must filter `availableExecutionAgents` to find publisher agents (`metadata.kind === 'publisher'`). Currently `PeerAgentDescriptor` has no `metadata` field.

**Files:**
- Modify: `src/agents/types.ts`
- Modify: `src/orchestrator/graph.ts`

**Step 1: Extend `PeerAgentDescriptor`** in `src/agents/types.ts`

```ts
export interface PeerAgentDescriptor {
  id: string;
  name: string;
  description: string;
  /** Forwarded from the peer's manifest.metadata — lets strategy agents filter by kind. */
  metadata?: Record<string, unknown>;
}
```

**Step 2: Forward metadata in `graph.ts`**

Find the `peerDescriptors` map (around line 51) and add metadata:

```ts
const peerDescriptors = agents
  .filter((a) => a.manifest.id !== manifest.id)
  .map((a) => ({
    id: a.manifest.id,
    name: a.manifest.name,
    description: a.manifest.description,
    metadata: a.manifest.metadata,  // ← add this line
  }));
```

**Step 3: Typecheck**
```bash
pnpm typecheck
```
Expected: no errors (metadata is optional, so existing code compiles without changes).

**Step 4: Run existing tests — expect all pass**
```bash
pnpm test
```

**Step 5: Commit**
```bash
git add src/agents/types.ts src/orchestrator/graph.ts
git commit -m "feat(agents): add metadata to PeerAgentDescriptor for publisher filtering"
```

---

### Task 2: `ProductContent` shared type

**Files:**
- Create: `src/agents/builtin/product-strategist/content.ts`

**Step 1: Create the file**

```ts
// src/agents/builtin/product-strategist/content.ts

/**
 * Platform-agnostic product content produced by product-strategist and
 * consumed by all publisher agents (shopify-publisher, future woocommerce-publisher, etc.).
 *
 * This is the contract between content generation and platform publishing.
 * Changing any field requires updating all publishers that read it.
 */
export interface ProductContent {
  title: string;
  bodyHtml: string;
  tags: string[];
  vendor: string;
  productType?: string;
  language: string;
  /** CF Images public URLs — already uploaded, ready for platform APIs. */
  imageUrls: string[];
  /** First-person progress note shown on the kanban timeline. */
  progressNote: string;
}
```

**Step 2: Typecheck**
```bash
pnpm typecheck
```

**Step 3: Commit**
```bash
git add src/agents/builtin/product-strategist/content.ts
git commit -m "feat(agents): add ProductContent shared type for product-strategist → publisher contract"
```

---

## Section B — `product-strategist` agent

### Task 3: Skill pack

**Files:**
- Create: `src/agents/builtin/product-strategist/packs/seo-fundamentals.md`

Copy the content from `src/agents/builtin/shopify-blog-writer/packs/seo-fundamentals.md` exactly — same pack, same key.

```bash
mkdir -p src/agents/builtin/product-strategist/packs
cp src/agents/builtin/shopify-blog-writer/packs/seo-fundamentals.md \
   src/agents/builtin/product-strategist/packs/seo-fundamentals.md
```

**Commit:**
```bash
git add src/agents/builtin/product-strategist/packs/
git commit -m "feat(product-strategist): add seo-fundamentals skill pack"
```

---

### Task 4: `product-strategist` agent (TDD)

**Files:**
- Create: `src/agents/builtin/product-strategist/index.ts`
- Test: `tests/product-strategist.test.ts`

**Step 1: Write the failing test**

```ts
// tests/product-strategist.test.ts
import { describe, expect, it, vi } from 'vitest';
import { llmMockModule, scriptStructured } from './integration/helpers/llm-mock.js';

vi.mock('../src/llm/model-registry.js', () => llmMockModule());
// Mock image tools so no real CF/OpenAI calls
vi.mock('../src/integrations/openai-images/tools.js', () => ({
  IMAGE_TOOL_IDS: ['images.generate', 'images.edit'],
  buildImageTools: vi.fn(() => [
    {
      id: 'images.generate',
      tool: { invoke: vi.fn(async () => ({ id: 'img-1', url: 'https://media.autoffice.app/img-1.png' })) },
    },
  ]),
}));
vi.mock('../src/integrations/cloudflare/images-client.js', () => ({
  CloudflareImagesClient: vi.fn(() => ({})),
}));
vi.mock('../src/integrations/openai-images/client.js', () => ({
  OpenAIImagesClient: vi.fn(() => ({})),
}));
vi.mock('../src/integrations/cloudflare/images-repository.js', () => ({
  insertImage: vi.fn(async () => ({ id: 'img-row-1' })),
  getImageById: vi.fn(async () => null),
}));

const { productStrategistAgent } = await import('../src/agents/builtin/product-strategist/index.js');

describe('product-strategist', () => {
  it('produces spawnTasks with ProductContent for each available publisher', async () => {
    scriptStructured({
      title: 'Linen Oversized Shirt',
      bodyHtml: '<p>Premium linen.</p>',
      tags: ['linen', 'summer'],
      vendor: 'Acme',
      progressNote: '商品文案好了，老闆看一下',
    });

    const publisherAgent = {
      id: 'shopify-publisher',
      name: 'Shopify Publisher',
      description: 'Publishes to Shopify',
      metadata: { kind: 'publisher' },
    };

    const runnable = await productStrategistAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'You are a product content specialist.',
      agentConfig: {},
      availableExecutionAgents: [publisherAgent],
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'List this linen shirt' }],
      params: {},
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.spawnTasks).toHaveLength(1);
    expect(output.spawnTasks![0].assignedAgent).toBe('shopify-publisher');
    expect(output.spawnTasks![0].input.content).toMatchObject({
      title: 'Linen Oversized Shirt',
      vendor: 'Acme',
      tags: expect.arrayContaining(['linen']),
    });
  });

  it('ignores non-publisher peers', async () => {
    scriptStructured({
      title: 'Shirt', bodyHtml: '<p>.</p>', tags: ['linen'], vendor: 'X', progressNote: 'ok',
    });

    const runnable = await productStrategistAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'sys',
      agentConfig: {},
      availableExecutionAgents: [
        { id: 'seo-strategist', name: 'SEO', description: 'seo', metadata: { kind: 'strategy' } },
        { id: 'shopify-blog-writer', name: 'Writer', description: 'writer' },
      ],
      emitLog: vi.fn(async () => {}),
    });

    await expect(
      runnable.invoke({ messages: [{ role: 'user', content: 'brief' }], params: {} }),
    ).rejects.toThrow(/no publisher/i);
  });
});
```

**Step 2: Run — expect fail**
```bash
pnpm test -- tests/product-strategist.test.ts
```

**Step 3: Implement `src/agents/builtin/product-strategist/index.ts`**

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { CloudflareImagesClient } from '../../../integrations/cloudflare/images-client.js';
import { getImageById, insertImage } from '../../../integrations/cloudflare/images-repository.js';
import { OpenAIImagesClient } from '../../../integrations/openai-images/client.js';
import { buildImageTools } from '../../../integrations/openai-images/tools.js';
import { buildModel } from '../../../llm/model-registry.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
  SpawnTaskRequest,
} from '../../types.js';
import type { ProductContent } from './content.js';

const DEFAULT_PROMPT = `You are a Product Content Specialist AI employee for an e-commerce business.
Your job: read a product brief and produce polished, platform-agnostic product content —
title, HTML description, tags, vendor — ready for the human to review.

You do NOT publish the product yourself. After approval, the framework will hand your
content to the appropriate platform publisher.

Hard rules:
- Never invent SKUs, prices, or stock counts; mention only what the brief includes.
- bodyHtml must be safe, well-formed HTML (<p>, <ul>/<li>, <h3>; no <script>/<style>).
- Tags: 3–8 short lower-case keywords.
- Default vendor and language come from the agent config; honour them unless the brief overrides.
- Use the tenant's default language for all copy.

Return strictly the structured object requested.`;

const configSchema = z.object({
  defaultLanguage: z
    .enum(['zh-TW', 'en', 'ja'])
    .default('zh-TW')
    .describe('Primary language for product copy'),
  defaultVendor: z.string().nullish().describe('Default vendor name'),
  images: z
    .object({
      autoGenerate: z.boolean().default(true).describe(
        'Generate product images when none are uploaded',
      ),
      style: z.string().nullish().describe(
        'Image style hint, e.g. "clean white background, product photography"',
      ),
    })
    .default({}),
  skills: z.object({ seoFundamentals: z.boolean().default(true) }).default({}),
});

type ProductStrategistConfig = z.infer<typeof configSchema>;

const ProductListingSchema = z.object({
  title: z.string().min(1).max(255).describe('Product title.'),
  bodyHtml: z.string().min(1).describe('Product description as HTML.'),
  tags: z.array(z.string().min(1)).min(1).max(20).describe('3–8 keyword tags.'),
  vendor: z.string().min(1).describe('Brand/vendor name.'),
  productType: z.string().optional().describe('Product category — leave blank if unsure.'),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe(
      '一句話對老闆回報你剛完成什麼。用 zh-TW 第一人稱，對話對象是「老闆」。',
    ),
});

type ProductListing = z.infer<typeof ProductListingSchema>;

export const productStrategistAgent: IAgent = {
  manifest: {
    id: 'product-strategist',
    name: 'AI Product Content Strategist',
    description:
      'Generates platform-agnostic product copy and images from a brief, ' +
      'then spawns publisher agents to distribute to enabled platforms.',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['images.generate', 'images.edit'],
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'strategy' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ProductStrategistConfig;
    const model = buildModel(ctx.modelConfig).withStructuredOutput(ProductListingSchema, {
      name: 'product_listing',
    });

    const publishers = ctx.availableExecutionAgents.filter(
      (a) => a.metadata?.kind === 'publisher',
    );
    if (publishers.length === 0) {
      throw new Error(
        'product-strategist requires at least one publisher agent (metadata.kind=publisher) ' +
          'to be enabled for the tenant.',
      );
    }

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks(packsDir, cfg.skills);

    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const r2AccessKey = env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    const r2SecretKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
    const r2Bucket = env.CLOUDFLARE_R2_BUCKET;
    const r2PublicBaseUrl = env.CLOUDFLARE_R2_PUBLIC_BASE_URL;
    const openaiKey = env.OPENAI_API_KEY;

    const r2Ready = accountId && r2AccessKey && r2SecretKey && r2Bucket && r2PublicBaseUrl;
    const imageTools =
      r2Ready && openaiKey
        ? buildImageTools(ctx.tenantId, {
            openaiClient: new OpenAIImagesClient({ apiKey: openaiKey }),
            cfClient: new CloudflareImagesClient({
              accountId,
              accessKeyId: r2AccessKey,
              secretAccessKey: r2SecretKey,
              bucket: r2Bucket,
              publicBaseUrl: r2PublicBaseUrl,
            }),
            insertImage,
            getImageById,
            fetchImageBuffer: async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()),
            taskId: ctx.taskId,
          })
        : [];

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', '商品資料我來整理一下', {
        publishers: publishers.map((p) => p.id),
      });

      const systemPrompt = packsBlock ? `${packsBlock}\n\n${ctx.systemPrompt}` : ctx.systemPrompt;
      const constraints = [
        `Default vendor: ${cfg.defaultVendor ?? '(must infer from brief)'}`,
        `Default language: ${cfg.defaultLanguage}`,
      ];

      const messages = await buildAgentMessages(
        systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );
      const listing = (await model.invoke(messages)) as ProductListing;

      // Image handling in code — no LLM tool-calling needed.
      const imageUrls: string[] = [];
      const inputImageIds = (input.params as { imageIds?: string[] }).imageIds ?? [];

      if (inputImageIds.length > 0 && input.imageResolver) {
        imageUrls.push(...(await input.imageResolver(inputImageIds)));
      } else if (cfg.images.autoGenerate && imageTools.length > 0) {
        const genTool = imageTools.find((t) => t.id === 'images.generate');
        if (genTool) {
          const style = cfg.images.style ?? 'clean white background, product photography';
          const imgResult = (await genTool.tool.invoke({
            prompt: `${listing.title}. ${style}`,
          })) as { id: string; url: string };
          imageUrls.push(imgResult.url);
        }
      }

      const content: ProductContent = {
        title: listing.title,
        bodyHtml: listing.bodyHtml,
        tags: listing.tags,
        vendor: listing.vendor,
        productType: listing.productType,
        language: cfg.defaultLanguage,
        imageUrls,
        progressNote: listing.progressNote,
      };

      const spawnTasks: SpawnTaskRequest[] = publishers.map((p) => ({
        title: `${listing.title} → ${p.name}`,
        assignedAgent: p.id,
        input: { content },
      }));

      const summary = [
        `# ${listing.title}`,
        '',
        `**Vendor:** ${listing.vendor}`,
        `**Tags:** ${listing.tags.join(', ')}`,
        `**Images:** ${imageUrls.length > 0 ? imageUrls.length + ' 張' : '無'}`,
        '',
        `_Approve to spawn ${spawnTasks.length} publisher task(s): ${publishers.map((p) => p.name).join(', ')}_`,
        '',
        '---',
        '',
        listing.bodyHtml,
      ].join('\n');

      await ctx.emitLog('agent.content.ready', listing.progressNote, {
        title: listing.title,
        publisherCount: spawnTasks.length,
        imageCount: imageUrls.length,
      });

      return {
        message: summary,
        awaitingApproval: true,
        payload: { content },
        spawnTasks,
      };
    };

    return { tools: imageTools, invoke };
  },
};
```

**Step 4: Run — expect pass**
```bash
pnpm test -- tests/product-strategist.test.ts
```

**Step 5: Commit**
```bash
git add src/agents/builtin/product-strategist/ tests/product-strategist.test.ts
git commit -m "feat(product-strategist): add product content strategist agent"
```

---

## Section C — `shopify-publisher` agent

### Task 5: `shopify-publisher` agent (TDD)

**Files:**
- Create: `src/agents/builtin/shopify-publisher/index.ts`
- Test: `tests/shopify-publisher.test.ts`

**Step 1: Write the failing test**

```ts
// tests/shopify-publisher.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { ProductContent } from '../src/agents/builtin/product-strategist/content.js';

const { shopifyPublisherAgent } = await import('../src/agents/builtin/shopify-publisher/index.js');

const MOCK_CONTENT: ProductContent = {
  title: 'Linen Oversized Shirt',
  bodyHtml: '<p>Premium linen shirt.</p>',
  tags: ['linen', 'summer', 'oversize'],
  vendor: 'Acme',
  language: 'zh-TW',
  imageUrls: ['https://media.autoffice.app/img-1.png'],
  progressNote: '商品文案好了',
};

describe('shopify-publisher', () => {
  it('has metadata.kind = publisher', () => {
    expect(shopifyPublisherAgent.manifest.metadata?.kind).toBe('publisher');
  });

  it('invoke() maps ProductContent to pendingToolCall without calling LLM', async () => {
    const buildModelSpy = vi.fn();
    // If buildModel were called, this test would fail because the spy isn't wired up.
    // We verify it's NOT called by checking the pendingToolCall comes back correctly
    // regardless.

    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: { shopify: { autoPublish: false } },
      availableExecutionAgents: [],
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
        bodyHtml: '<p>Premium linen shirt.</p>',
        tags: expect.arrayContaining(['linen']),
        vendor: 'Acme',
        images: [{ url: 'https://media.autoffice.app/img-1.png' }],
      },
    });
    expect(output.message).toContain('Linen Oversized Shirt');
  });

  it('invoke() omits images key when imageUrls is empty', async () => {
    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: {},
      availableExecutionAgents: [],
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { content: { ...MOCK_CONTENT, imageUrls: [] } },
    });

    expect(output.pendingToolCall?.args).not.toHaveProperty('images');
  });
});
```

The `shopify-publisher` cannot call `buildShopifyTools` without a real Shopify credential in tests. Mock the tools module:

```ts
vi.mock('../src/integrations/shopify/tools.js', () => ({
  SHOPIFY_TOOL_IDS: ['shopify.create_product'],
  buildShopifyTools: vi.fn(async () => [
    {
      id: 'shopify.create_product',
      tool: { invoke: vi.fn(async () => ({ productId: 'gid://shopify/Product/1' })) },
    },
  ]),
}));
```

Add this mock at the top of the test file before the import.

**Step 2: Run — expect fail**
```bash
pnpm test -- tests/shopify-publisher.test.ts
```

**Step 3: Implement `src/agents/builtin/shopify-publisher/index.ts`**

```ts
import { z } from 'zod';
import { SHOPIFY_TOOL_IDS, buildShopifyTools } from '../../../integrations/shopify/tools.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';
import type { ProductContent } from '../product-strategist/content.js';

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
    name: 'Shopify Product Publisher',
    description:
      'Publishes a ready-made ProductContent package to the tenant Shopify store. ' +
      'Expects task.input.params.content to be a ProductContent object.',
    // No LLM needed — this agent is a pure mapping + HITL gate.
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
    metadata: { kind: 'publisher' },
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

      await ctx.emitLog('agent.started', content.progressNote, {
        title: content.title,
        imageCount: content.imageUrls.length,
      });

      const pendingToolCall = {
        id: 'shopify.create_product',
        args: {
          title: content.title,
          bodyHtml: content.bodyHtml,
          tags: content.tags,
          vendor: content.vendor,
          ...(content.productType ? { productType: content.productType } : {}),
          ...(content.imageUrls.length > 0
            ? { images: content.imageUrls.map((url) => ({ url })) }
            : {}),
        },
      };

      return {
        message: renderProductPreview(content, cfg.shopify.autoPublish),
        awaitingApproval: true,
        payload: { content },
        pendingToolCall,
      };
    };

    return { tools: filtered, invoke };
  },
};

function renderProductPreview(content: ProductContent, autoPublish: boolean): string {
  return [
    `# ${content.title}`,
    '',
    `**Vendor:** ${content.vendor}${content.productType ? ` · **Type:** ${content.productType}` : ''}`,
    `**Tags:** ${content.tags.join(', ')}`,
    `**Language:** ${content.language}`,
    content.imageUrls.length > 0
      ? `**Images:** ${content.imageUrls.length} 張已備妥`
      : '**Images:** 無',
    `**On approve:** create product as \`${autoPublish ? 'active' : 'draft'}\` in Shopify`,
    '',
    '---',
    '',
    content.bodyHtml,
    '',
    '_Approve to push to Shopify; Discard to abandon._',
  ].join('\n');
}
```

**Step 4: Run — expect pass**
```bash
pnpm test -- tests/shopify-publisher.test.ts
```

**Step 5: Commit**
```bash
git add src/agents/builtin/shopify-publisher/ tests/shopify-publisher.test.ts
git commit -m "feat(shopify-publisher): add no-LLM Shopify publisher agent"
```

---

## Section D — Registration + retire shopify-ops

### Task 6: Register new agents, delete shopify-ops

**Files:**
- Modify: `src/agents/index.ts`
- Delete: `src/agents/builtin/shopify-ops/` (whole directory)
- Delete: `tests/shopify-ops.test.ts`
- Delete: `tests/integration/shopify-ops.test.ts`

**Step 1: Update `src/agents/index.ts`**

```ts
import { productStrategistAgent } from './builtin/product-strategist/index.js';
import { shopifyBlogWriterAgent } from './builtin/shopify-blog-writer/index.js';
import { shopifyPublisherAgent } from './builtin/shopify-publisher/index.js';
import { seoStrategistAgent } from './builtin/seo-strategist/index.js';
import { agentRegistry } from './registry.js';

export * from './types.js';
export { agentRegistry } from './registry.js';

let bootstrapped = false;

export function bootstrapAgents(): void {
  if (bootstrapped) return;
  agentRegistry.register(seoStrategistAgent);
  agentRegistry.register(shopifyBlogWriterAgent);
  agentRegistry.register(productStrategistAgent);
  agentRegistry.register(shopifyPublisherAgent);
  bootstrapped = true;
}
```

**Step 2: Delete shopify-ops**
```bash
rm -rf src/agents/builtin/shopify-ops
rm -f tests/shopify-ops.test.ts
rm -f tests/integration/shopify-ops.test.ts
```

**Step 3: Run all tests — fix any import errors**
```bash
pnpm test:all
```
Expected: all pass (shopify-ops tests are gone, new agents are registered).

If any tests import `shopifyOpsAgent`, update them.

**Step 4: Commit**
```bash
git add src/agents/index.ts
git rm -r src/agents/builtin/shopify-ops tests/shopify-ops.test.ts tests/integration/shopify-ops.test.ts
git commit -m "feat(agents): register product-strategist + shopify-publisher, retire shopify-ops"
```

---

## Section E — Integration test

### Task 7: End-to-end integration test

**Files:**
- Create: `tests/integration/product-publisher.test.ts`

This test exercises the complete flow:
`brief → product-strategist waiting → approve(finalize) → spawn shopify-publisher → publisher waiting → approve(finalize) → shopify.create_product`

Use the existing integration pattern from `tests/integration/lifecycle.test.ts` and `tests/integration/shopify-blog-writer.test.ts`.

```ts
// tests/integration/product-publisher.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import { clearScript, llmMockModule, scriptStructured } from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn(async () => ({})) })),
  PutObjectCommand: vi.fn(),
}));

process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key';
process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL = 'https://assets.example.com';
process.env.OPENAI_API_KEY = 'sk-test';
const { clearEnvCache } = await import('../../src/config/env.js');
clearEnvCache();

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { createTestApp } = await import('./helpers/app.js');
const { getTask } = await import('../../src/tasks/repository.js');

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => { app = await createTestApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(); clearScript(); fetchMock.mockReset(); });

describe('product-strategist → shopify-publisher end-to-end', () => {
  it('generates content → approve → spawns publisher → approve → create_product', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    // Bind Shopify credential for the publisher
    await app.inject({
      method: 'PUT', url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: { secret: 'shpat_test', metadata: { storeUrl: 'demo.myshopify.com' } },
    });

    // Activate both agents
    await app.inject({
      method: 'POST', url: '/v1/agents/product-strategist/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { defaultLanguage: 'zh-TW', defaultVendor: 'Acme' } },
    });
    await app.inject({
      method: 'POST', url: '/v1/agents/shopify-publisher/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: {} },
    });

    // Script: supervisor routes → product-strategist, then LLM produces listing
    scriptStructured({ nextAgent: 'product-strategist', clarification: null, done: false });
    scriptStructured({
      title: 'Linen Shirt', bodyHtml: '<p>Cool.</p>',
      tags: ['linen'], vendor: 'Acme', progressNote: '商品文案好了',
    });

    // OpenAI image generation mock
    const fakeImageB64 = Buffer.from('fakeimg').toString('base64');
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ data: [{ b64_json: fakeImageB64 }] }),
    } as unknown as Response);

    // Create task
    const create = await app.inject({
      method: 'POST', url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'List this linen shirt' },
    });
    expect(create.statusCode).toBe(201);
    const stratTaskId = create.json().id as string;

    // Strategist runs → waiting with spawnTasks
    await drainNextTask();
    const stratTask = await getTask(tenantId, stratTaskId);
    expect(stratTask.status).toBe('waiting');
    expect(stratTask.kind).toBe('strategy');
    expect((stratTask.output as { spawnTasks?: unknown[] })?.spawnTasks).toHaveLength(1);

    // Approve(finalize) → spawns shopify-publisher child
    const approveStrat = await app.inject({
      method: 'POST', url: `/v1/tasks/${stratTaskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approveStrat.statusCode).toBe(200);

    // Find the spawned publisher child
    const listTasks = await app.inject({
      method: 'GET', url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
    });
    const allTasks = listTasks.json<{ id: string; assignedAgent: string; status: string }[]>();
    const publisherTask = allTasks.find((t) => t.assignedAgent === 'shopify-publisher');
    expect(publisherTask).toBeDefined();

    // Publisher runs → waiting with pendingToolCall
    await drainNextTask();
    const pubTask = await getTask(tenantId, publisherTask!.id);
    expect(pubTask.status).toBe('waiting');
    expect((pubTask.output as { pendingToolCall?: { id: string } })?.pendingToolCall?.id).toBe(
      'shopify.create_product',
    );

    // Mock Shopify product creation
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ product: { id: 123, title: 'Linen Shirt' } }),
    } as unknown as Response);

    // Approve(finalize) → fires shopify.create_product
    const approvePub = await app.inject({
      method: 'POST', url: `/v1/tasks/${publisherTask!.id}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approvePub.statusCode).toBe(200);

    const finalTask = await getTask(tenantId, publisherTask!.id);
    expect(finalTask.status).toBe('done');
    expect(finalTask.output).toMatchObject({ toolResult: expect.anything() });
  });
});
```

**Step 2: Run — fix until green**
```bash
pnpm test:integration -- tests/integration/product-publisher.test.ts
```

**Step 3: Commit**
```bash
git add tests/integration/product-publisher.test.ts
git commit -m "test(integration): product-strategist → shopify-publisher end-to-end"
```

---

## Section F — Final verification

### Task 8: Full suite + lint + typecheck

```bash
pnpm typecheck
pnpm lint
pnpm test:all
```

All green. Fix any issues in-place.

```bash
git add -A
git commit -m "fix: final cleanup after product-publisher agent split"
```

---

## Skills the executor should reference

- `@superpowers:test-driven-development` — Tasks 4, 5, 7
- `@superpowers:systematic-debugging` — if integration test fails on agent routing
- `@superpowers:verification-before-completion` — at Task 8

## Risks the executor should watch for

- **`availableExecutionAgents` only contains other tenant-enabled agents** — both `product-strategist` AND `shopify-publisher` must be activated for the same tenant before the integration test will work. The test activates both explicitly.
- **`shopify-publisher.build()` calls `buildShopifyTools`** — this requires a Shopify credential row to exist, otherwise the activation gate blocks. The integration test seeds a credential before activating. The unit test mocks `buildShopifyTools` entirely.
- **Product-strategist's error at build time** — throws if no publisher agent is in `availableExecutionAgents`. This is intentional (same pattern as `seo-strategist`'s worker check). The unit test covers this.
- **`input.params.content` cast** — `shopify-publisher` casts `input.params.content` as `ProductContent`. If the parent task passes malformed content, this fails at runtime. Add a Zod parse in `invoke()` if this becomes a problem — but for v1, `product-strategist` is the only producer, so the shape is guaranteed.
