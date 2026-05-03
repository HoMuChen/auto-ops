# Product Planner + Designer Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `product-strategist` with two agents — `product-planner` (marketing strategy + serper research) and `product-designer` (image generation + copywriting) — following the design doc at `docs/plans/2026-05-03-product-planner-designer-split.md`.

**Architecture:** product-planner is a strategy agent that researches competitors via Serper and spawns one product-designer task per content variant. product-designer runs the existing `runToolLoop` for images then a structured-output pass for copy, then spawns shopify-publisher tasks. imageUrls state is managed across feedback rounds: previous generated images are carried forward in taskOutput and used as baseline unless the LLM generates new ones.

**Tech Stack:** TypeScript, LangChain, LangGraph, Zod, Vitest. All LLM calls mocked in unit tests via `bindTools`/`withStructuredOutput` mocks (see `tests/seo-strategist.test.ts` for the pattern).

---

### Task 1: Delete product-strategist + update index.ts

**Files:**
- Delete: `src/agents/builtin/product-strategist/` (entire directory)
- Modify: `src/agents/index.ts`
- Delete: `tests/product-strategist.test.ts`

**Step 1: Remove the directory and test**

```bash
rm -rf src/agents/builtin/product-strategist
rm tests/product-strategist.test.ts
```

**Step 2: Update src/agents/index.ts**

Replace the entire file with:

```ts
import { productDesignerAgent } from './builtin/product-designer/index.js';
import { productPlannerAgent } from './builtin/product-planner/index.js';
import { seoStrategistAgent } from './builtin/seo-strategist/index.js';
import { shopifyBlogWriterAgent } from './builtin/shopify-blog-writer/index.js';
import { shopifyPublisherAgent } from './builtin/shopify-publisher/index.js';
import { agentRegistry } from './registry.js';

export * from './types.js';
export { agentRegistry } from './registry.js';

let bootstrapped = false;

export function bootstrapAgents(): void {
  if (bootstrapped) return;
  agentRegistry.register(seoStrategistAgent);
  agentRegistry.register(shopifyBlogWriterAgent);
  agentRegistry.register(productPlannerAgent);
  agentRegistry.register(productDesignerAgent);
  agentRegistry.register(shopifyPublisherAgent);
  bootstrapped = true;
}
```

**Step 3: Verify typecheck (will fail — new agents don't exist yet, that's expected)**

```bash
pnpm typecheck 2>&1 | head -20
```

Expected: errors about missing `product-planner` and `product-designer` imports.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove product-strategist in preparation for planner+designer split"
```

---

### Task 2: Create product-planner skill packs

**Files:**
- Create: `src/agents/builtin/product-planner/packs/product-positioning.md`
- Create: `src/agents/builtin/product-planner/packs/ecommerce-marketing.md`
- Create: `src/agents/builtin/product-planner/packs/seo-fundamentals.md`

**Step 1: Create directory**

```bash
mkdir -p src/agents/builtin/product-planner/packs
```

**Step 2: Create product-positioning.md**

```markdown
---
key: productPositioning
name: Product Positioning
version: 1
---

## USP Mining Framework

For every product brief, identify the USP across three dimensions:
- **Functional**: what the product does better (material, durability, performance)
- **Emotional**: how it makes the buyer feel (confidence, belonging, relief)
- **Situational**: the specific moment/context it serves best (commute, travel, gym)

Pick the strongest dimension given the brief. Do NOT try to cover all three in one angle.

## Competitive Differentiation

When SERP data is available, look for gaps in competitor angles:
- Topics competitors are NOT addressing (even if obvious)
- Audience segments competitors ignore (size, age, climate, lifestyle)
- Claims competitors make that you can out-evidence (durability tests, certifications)

## Audience Segmentation

Define the primary segment before writing any brief. Include:
- Demographics (narrow enough to be useful — "women 25-40 in urban Taiwan" not "women")
- Behaviour (what they search, what they buy instead today)
- Core pain point (one sentence)

One variant = one audience segment. Do not mix segments in a single variant.
```

**Step 3: Create ecommerce-marketing.md**

```markdown
---
key: ecommerceMarketing
name: E-commerce Marketing
version: 1
---

## Content Angle Types

Choose one per variant:

| Angle | When to use | Example hook |
|-------|-------------|--------------|
| **Seasonal** | Product has peak demand window | "台灣梅雨季必備" |
| **Use-case** | Product solves a specific scenario | "通勤族的第一件亞麻襯衫" |
| **Problem-solution** | Audience has a known frustration | "再也不怕悶熱出汗" |
| **Identity** | Product signals belonging to a group | "永續生活入門款" |
| **Comparison** | Category is crowded, buyer is evaluating | "亞麻 vs 棉：哪個更透氣" |

## Multi-Platform Copy Differences

- **E-commerce (Shopify)**: benefit-first headline, feature list, trust signals (material cert, care instructions). Buyer is in purchase mode.
- **Instagram**: emotion-first, lifestyle framing, shorter sentences. Buyer is in discovery mode.
- **Facebook**: slightly longer, can explain context, good for comparison angles.

## Conversion Copy Principles

- Lead with the benefit, follow with the feature: "不悶熱（benefit）— 180g 亞麻布料（feature）"
- One core message per variant. Resist adding secondary benefits.
- Forbidden claim patterns: superlatives without evidence ("最好的"), vague sustainability claims ("環保"), unverifiable medical claims.
```

**Step 4: Copy seo-fundamentals.md from seo-strategist packs**

```bash
cp src/agents/builtin/seo-strategist/packs/seo-fundamentals.md \
   src/agents/builtin/product-planner/packs/seo-fundamentals.md
```

**Step 5: Commit**

```bash
git add src/agents/builtin/product-planner/packs/
git commit -m "feat(product-planner): add skill packs — product-positioning, ecommerce-marketing, seo-fundamentals"
```

---

### Task 3: Create product-designer skill packs

**Files:**
- Create: `src/agents/builtin/product-designer/packs/product-photography.md`
- Create: `src/agents/builtin/product-designer/packs/social-media-images.md`

**Step 1: Create directory**

```bash
mkdir -p src/agents/builtin/product-designer/packs
```

**Step 2: Create product-photography.md**

```markdown
---
key: productPhotography
name: Product Photography
version: 1
---

## Standard Listing Image Set (3–5 images)

| Shot type | Ratio | Description |
|-----------|-------|-------------|
| Hero | 1:1 | Clean white/light background, full product centred, no props |
| Lifestyle | 4:5 | Product in use or natural context, person or environment visible |
| Detail | 1:1 | Close-up of material, texture, label, or key feature |
| Scale | 1:1 | Product next to common object (hand, coffee cup) to show size |
| Flat lay | 1:1 | Overhead arrangement, product with complementary items |

## Composition Principles

- **Hero shot**: product fills 60–70% of frame, even negative space on all sides
- **Lifestyle**: rule of thirds, product in bottom-left or right third
- **Detail**: macro focus, blurred background (f/1.8–2.8 equivalent in prompt)
- **Flat lay**: symmetrical or diagonal arrangement, consistent colour palette

## Prompt Construction for images.generate

Structure: `[subject] [action/pose], [background], [lighting], [style], [technical]`

Example: `"linen oversized shirt folded flat, clean white background, soft natural light from left, product photography, 1:1 aspect ratio"`

Always specify aspect ratio in the prompt.
```

**Step 3: Create social-media-images.md**

```markdown
---
key: socialMediaImages
name: Social Media Image Specs
version: 1
---

## Platform Ratios

| Platform | Placement | Ratio | Pixels | Notes |
|----------|-----------|-------|--------|-------|
| Instagram | Feed square | 1:1 | 1080×1080 | Safe for all feed types |
| Instagram | Feed portrait | 4:5 | 1080×1350 | More screen real estate |
| Instagram | Stories / Reels | 9:16 | 1080×1920 | Full screen vertical |
| Facebook | Feed / Ad | 1.91:1 | 1200×628 | Landscape, wide crop |
| LINE | VOOM / Timeline | 1:1 | 1040×1040 | Square preferred |

## Safe Zones

- **9:16 Stories**: keep key content in centre 1080×1420px — top/bottom 250px may be clipped by UI
- **1.91:1 Facebook**: text within 80% of width; edges risk crop on mobile
- **4:5 Instagram**: no safe-zone issue, full bleed is fine

## Copy Placement

When generating images with text overlay:
- Centre-bottom third for 1:1 and 4:5
- Centre frame (avoid top/bottom) for 9:16
- Keep text area contrast ≥ 4.5:1 (WCAG AA) — use solid colour band or semi-transparent overlay

## Prompt Additions for Social

- 1:1: append `"square composition, 1:1 aspect ratio"`
- 4:5: append `"portrait composition, 4:5 aspect ratio, vertical framing"`
- 9:16: append `"vertical full-bleed, 9:16 aspect ratio, subject centred in middle third"`
- 1.91:1: append `"wide landscape, 1.91:1 aspect ratio, subject left-of-centre"`
```

**Step 4: Commit**

```bash
git add src/agents/builtin/product-designer/packs/
git commit -m "feat(product-designer): add skill packs — product-photography, social-media-images"
```

---

### Task 4: Write failing tests for product-planner

**Files:**
- Create: `tests/product-planner.test.ts`

**Step 1: Create the test file**

```ts
import { describe, expect, it, vi } from 'vitest';

/**
 * product-planner: strategy agent that researches via Serper and spawns
 * product-designer tasks — one per content variant.
 */

const planFixture = {
  reasoning: 'Two variants covering e-commerce and Instagram for the Taiwan market.',
  summary: '規劃了兩個方向，一個主打電商上架，一個針對 IG 社群，老闆確認一下方向',
  progressNote: '研究完競品後規劃了 2 個 variants，老闆看一下',
  variants: [
    {
      title: '亞麻短袖 - 電商版 (zh-TW)',
      platform: 'shopify',
      language: 'zh-TW',
      marketingAngle: '機能透氣，台灣濕熱夏天通勤族',
      keyMessages: ['180g 亞麻不悶熱', '台灣製造', '可機洗'],
      copyBrief: {
        tone: 'warm, professional',
        featuresToHighlight: ['fabric weight', 'washability'],
      },
      imagePlan: [
        { purpose: 'hero shot', styleHint: 'clean white background', priority: 'required' },
        { purpose: 'lifestyle - commute scene', styleHint: 'urban morning', priority: 'optional' },
      ],
      assignedAgent: 'product-designer',
    },
    {
      title: '亞麻短袖 - Instagram 版 (zh-TW)',
      platform: 'instagram',
      language: 'zh-TW',
      marketingAngle: '永續生活入門款',
      keyMessages: ['天然亞麻', '少買好物'],
      copyBrief: {
        tone: 'casual, aspirational',
        featuresToHighlight: ['natural material', 'timeless style'],
      },
      imagePlan: [
        { purpose: 'lifestyle flat lay', styleHint: 'warm tones, linen texture', priority: 'required' },
      ],
      assignedAgent: 'product-designer',
    },
  ],
};

// Pass 1: tool-calling (serper search) — no tool_calls so loop exits immediately
const toolPassInvokeMock = vi.fn(async () => ({ content: '', tool_calls: [] }));
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

// Pass 2: structured plan output
const planPassInvokeMock = vi.fn(async () => planFixture);
const withStructuredOutputMock = vi.fn(() => ({ invoke: planPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
    withStructuredOutput: withStructuredOutputMock,
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

const { productPlannerAgent } = await import('../src/agents/builtin/product-planner/index.js');

const designerPeer = {
  id: 'product-designer',
  name: 'Product Designer',
  description: 'Generates images and copy from a variant spec.',
};

describe('product-planner', () => {
  it('spawns one product-designer task per variant', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'You are a product planner.',
      agentConfig: {},
      availableExecutionAgents: [designerPeer],
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'Plan content for this linen shirt' }],
      params: {},
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.spawnTasks).toHaveLength(2);
    expect(output.spawnTasks![0]!.assignedAgent).toBe('product-designer');
    expect(output.spawnTasks![0]!.input.variantSpec).toMatchObject({
      title: '亞麻短袖 - 電商版 (zh-TW)',
      assignedAgent: 'product-designer',
    });
  });

  it('throws when no product-designer peer is available', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'sys',
      agentConfig: {},
      availableExecutionAgents: [],
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
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { imageIds: ['img-uuid-1', 'img-uuid-2'] },
    });

    expect(output.spawnTasks![0]!.input.originalImageIds).toEqual(['img-uuid-1', 'img-uuid-2']);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/product-planner.test.ts 2>&1 | tail -15
```

Expected: FAIL — `Cannot find module '../src/agents/builtin/product-planner/index.js'`

**Step 3: Commit the failing test**

```bash
git add tests/product-planner.test.ts
git commit -m "test(product-planner): add failing tests before implementation"
```

---

### Task 5: Implement product-planner

**Files:**
- Create: `src/agents/builtin/product-planner/index.ts`

**Step 1: Create the implementation**

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
import { buildModel } from '../../../llm/model-registry.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import { runToolLoop } from '../../lib/tool-loop.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
  SpawnTaskRequest,
} from '../../types.js';

const DEFAULT_PROMPT = `You are a Product Marketing Planner AI employee for an e-commerce business.
Your job: read a product brief and produce a set of content variants — one per target
platform/language/audience combination — each ready to hand off to a product designer.

For every variant you MUST provide:
- A clear marketing angle (one sentence: who this is for, what pain it solves).
- The key messages (2–4 bullets the designer must weave into the copy).
- A copy brief (tone, features to highlight, forbidden claims).
- An image plan: list of shots with purpose and style hint. Do NOT specify ratios or
  exact prompts — the designer's domain knowledge handles those.
- The assignedAgent must always be "product-designer".

Workflow:
1. If serper_search is available, search 1–3 queries to understand competitor angles and
   trending keywords for this product category.
2. Use SERP insights to identify differentiation gaps and audience angles.
3. Produce the structured variant plan.

Constraints:
- Plan between 1 and {MAX_VARIANTS} variants.
- Each variant targets a distinct audience/platform combination — do not duplicate angles.
- Honor any brand tone or keyword constraints from the config.`;

const ImageBriefSchema = z.object({
  purpose: z.string().min(2).describe('Shot type and scene, e.g. "hero shot" or "lifestyle - morning commute"'),
  styleHint: z.string().min(2).describe('Lighting, mood, background direction. No ratios or prompts.'),
  priority: z.enum(['required', 'optional']),
});

const DesignerVariantSchema = z.object({
  title: z.string().min(1).describe('Short label for the kanban card, e.g. "亞麻短袖 - 電商版 (zh-TW)"'),
  platform: z.string().optional().describe('Target platform: "shopify", "instagram", "facebook", etc.'),
  language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
  marketingAngle: z.string().min(10).describe('One sentence: who this is for and what pain it solves.'),
  keyMessages: z.array(z.string().min(1)).min(1).max(5),
  copyBrief: z.object({
    tone: z.string().min(2),
    featuresToHighlight: z.array(z.string()).min(1),
    forbiddenClaims: z.array(z.string()).default([]),
  }),
  imagePlan: z.array(ImageBriefSchema).min(1).max(6),
  assignedAgent: z.literal('product-designer'),
  scheduledAt: z.string().datetime().optional(),
});

const PlanSchema = z.object({
  reasoning: z.string().describe('One-paragraph rationale for the chosen variants.'),
  summary: z
    .string()
    .min(20)
    .max(500)
    .describe(
      '給老闆看的匯報摘要。說明你做了什麼研究、有什麼特別考量。' +
        '用 zh-TW，語氣像員工向老闆口頭匯報，3–5 句話。',
    ),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe('一句話對老闆回報整體規劃思路。用 zh-TW 第一人稱，對話對象是「老闆」。'),
  variants: z.array(DesignerVariantSchema).min(1),
});

type ContentPlan = z.infer<typeof PlanSchema>;
type DesignerVariant = z.infer<typeof DesignerVariantSchema>;

const configSchema = z.object({
  maxVariants: z.number().int().min(1).max(10).default(5)
    .describe('Maximum number of content variants to plan per brief'),
  defaultLanguages: z.array(z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])).min(1).default(['zh-TW']),
  brandTone: z.string().nullish(),
  preferredKeywords: z.array(z.string()).default([]),
  useSerperSearch: z.boolean().default(true).describe('Search competitor SERPs before planning'),
  skills: z.object({
    seoFundamentals: z.boolean().default(true),
    productPositioning: z.boolean().default(true),
    ecommerceMarketing: z.boolean().default(true),
  }).default({}),
});

type ProductPlannerConfig = z.infer<typeof configSchema>;

export const productPlannerAgent: IAgent = {
  manifest: {
    id: 'product-planner',
    name: 'AI Product Planner',
    description:
      'Plans product content strategy: researches competitor angles via Serper, ' +
      'produces N content variants (platform × language × audience), ' +
      'and spawns a Product Designer task for each variant.',
    defaultModel: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['serper.search'],
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'strategy' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ProductPlannerConfig;

    const designerPeer = ctx.availableExecutionAgents.find((a) => a.id === 'product-designer');
    if (!designerPeer) {
      // Checked at invoke time (after build) in the runner; guard here for clarity.
    }

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks(packsDir, cfg.skills as Record<string, boolean>);

    const serperKey = env.SERPER_API_KEY;
    const serperTools =
      cfg.useSerperSearch && serperKey
        ? buildSerperTools({
            tenantId: ctx.tenantId,
            cache: new SerpCache(new SerperClient({ apiKey: serperKey })),
          })
        : [];

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      if (!ctx.availableExecutionAgents.find((a) => a.id === 'product-designer')) {
        throw new Error(
          'product-planner requires product-designer to be enabled for this tenant',
        );
      }

      await ctx.emitLog('agent.started', '研究一下競品，幫你規劃幾個方向', {
        maxVariants: cfg.maxVariants,
        useSerper: serperTools.length > 0,
      });

      const constraints: string[] = [
        `Maximum variants: ${cfg.maxVariants}`,
        `Default languages: ${cfg.defaultLanguages.join(', ')}`,
        ...(cfg.brandTone ? [`Brand tone: ${cfg.brandTone}`] : []),
        ...(cfg.preferredKeywords.length > 0
          ? [`Preferred keywords: ${cfg.preferredKeywords.join(', ')}`]
          : []),
      ];

      const basePrompt = ctx.systemPrompt.replace('{MAX_VARIANTS}', String(cfg.maxVariants));
      const systemPrompt = packsBlock ? `${packsBlock}\n\n${basePrompt}` : basePrompt;

      const baseMessages = await buildAgentMessages(
        systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );

      // Pass 1: serper research loop
      const { collected } = await runToolLoop({
        modelConfig: ctx.modelConfig,
        messages: baseMessages,
        tools: serperTools,
        maxHops: 6,
        emitLog: ctx.emitLog,
      });

      // Pass 2: structured variant plan
      const planModel = buildModel(ctx.modelConfig).withStructuredOutput(PlanSchema, {
        name: 'product_content_plan',
      });
      const plan = (await planModel.invoke([
        ...collected,
        new HumanMessage('Now produce the final structured content plan.'),
      ])) as ContentPlan;

      const capped = plan.variants.slice(0, cfg.maxVariants);

      const originalImageIds = (input.params as { imageIds?: string[] }).imageIds ?? [];

      const spawnTasks: SpawnTaskRequest[] = capped.map((v: DesignerVariant) => ({
        title: v.title,
        description: `Product content — ${v.marketingAngle}`,
        assignedAgent: 'product-designer',
        input: {
          variantSpec: v,
          originalImageIds,
        },
        ...(v.scheduledAt ? { scheduledAt: v.scheduledAt } : {}),
      }));

      const summary = [
        `# Product Content Plan (${capped.length} variants)`,
        '',
        plan.summary,
        '',
        ...capped.map(
          (v: DesignerVariant, i: number) =>
            `${i + 1}. **${v.title}**${v.platform ? ` _(${v.platform})_` : ''} — ${v.marketingAngle}`,
        ),
        '',
        '_Approve to spawn each variant as an independent designer task._',
      ].join('\n');

      await ctx.emitLog('agent.plan.ready', plan.progressNote, {
        variantCount: capped.length,
      });

      return {
        message: summary,
        awaitingApproval: true,
        payload: { plan: { reasoning: plan.reasoning, variants: capped } },
        spawnTasks,
      };
    };

    return { tools: [], invoke };
  },
};
```

**Step 2: Run the failing tests**

```bash
pnpm test -- tests/product-planner.test.ts 2>&1 | tail -20
```

Expected: all 3 tests PASS.

**Step 3: Typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: still errors from missing product-designer. That's ok for now.

**Step 4: Commit**

```bash
git add src/agents/builtin/product-planner/index.ts
git commit -m "feat(product-planner): implement strategy agent with serper research and variant planning"
```

---

### Task 6: Write failing tests for product-designer

**Files:**
- Create: `tests/product-designer.test.ts`

**Step 1: Create the test file**

```ts
import { describe, expect, it, vi } from 'vitest';

/**
 * product-designer: execution agent that receives a variant spec from product-planner,
 * generates images via tool loop, writes copy, then spawns publisher tasks.
 *
 * Key behaviours tested:
 * 1. Happy path: spawns shopify-publisher with ProductContent
 * 2. Feedback round: preserves previous imageUrls when no tool calls fire
 * 3. Feedback round: replaces imageUrls when LLM generates new images
 */

const listingFixture = {
  title: 'Linen Oversized Shirt',
  bodyHtml: '<p>Premium 180g linen.</p>',
  tags: ['linen', 'summer', 'oversized'],
  vendor: 'Acme',
  progressNote: '文案好了，老闆看一下',
};

// Pass 1 mock: no tool calls by default (overridden per test)
let toolPassResponse = { content: '', tool_calls: [] as { name: string; id: string; args: Record<string, unknown> }[] };
const toolPassInvokeMock = vi.fn(async () => toolPassResponse);
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

// Pass 2 mock
const listingPassInvokeMock = vi.fn(async () => listingFixture);
const withStructuredOutputMock = vi.fn(() => ({ invoke: listingPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
    withStructuredOutput: withStructuredOutputMock,
  })),
}));

const generateToolInvoke = vi.fn(async () => ({ id: 'img-1', url: 'https://cdn.example.com/img-1.jpg' }));

vi.mock('../src/integrations/openai-images/tools.js', () => ({
  IMAGE_TOOL_IDS: ['images.generate', 'images.edit'],
  buildImageTools: vi.fn(() => [
    {
      id: 'images.generate',
      tool: { name: 'images_generate', invoke: generateToolInvoke },
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
  insertImage: vi.fn(async () => ({ id: 'row-1' })),
  getImageById: vi.fn(async () => null),
}));

const { productDesignerAgent } = await import('../src/agents/builtin/product-designer/index.js');

const publisherPeer = {
  id: 'shopify-publisher',
  name: 'Shopify Publisher',
  description: 'Publishes to Shopify',
  metadata: { kind: 'publisher' },
};

const variantSpec = {
  title: '亞麻短袖 - 電商版',
  platform: 'shopify',
  language: 'zh-TW',
  marketingAngle: '機能透氣，台灣通勤族',
  keyMessages: ['不悶熱', '可機洗'],
  copyBrief: { tone: 'warm', featuresToHighlight: ['fabric'] },
  imagePlan: [{ purpose: 'hero shot', styleHint: 'white background', priority: 'required' }],
  assignedAgent: 'product-designer',
};

function buildCtx(overrides = {}) {
  return {
    tenantId: 't1',
    taskId: 'task-1',
    modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.3 },
    systemPrompt: 'You are a product designer.',
    agentConfig: {},
    availableExecutionAgents: [publisherPeer],
    emitLog: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('product-designer', () => {
  it('spawns shopify-publisher with ProductContent on first run', async () => {
    toolPassResponse = { content: '', tool_calls: [] };

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { variantSpec, originalImageIds: [] },
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.spawnTasks).toHaveLength(1);
    expect(output.spawnTasks![0]!.assignedAgent).toBe('shopify-publisher');
    const content = output.spawnTasks![0]!.input.content as { title: string };
    expect(content.title).toBe('Linen Oversized Shirt');
  });

  it('preserves previous imageUrls when feedback does not trigger image generation', async () => {
    toolPassResponse = { content: '', tool_calls: [] }; // no tool calls

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }, { role: 'assistant', content: 'draft' }, { role: 'user', content: 'copy tone is too formal' }],
      params: { variantSpec, originalImageIds: [] },
      taskOutput: { payload: { content: { imageUrls: ['https://cdn.example.com/prev.jpg'] } } },
    });

    const content = output.spawnTasks![0]!.input.content as { imageUrls: string[] };
    expect(content.imageUrls).toEqual(['https://cdn.example.com/prev.jpg']);
  });

  it('replaces imageUrls when LLM generates new images on feedback', async () => {
    // Simulate LLM calling images_generate once then stopping
    let hop = 0;
    toolPassInvokeMock.mockImplementation(async () => {
      if (hop === 0) {
        hop++;
        return {
          content: '',
          tool_calls: [{ name: 'images_generate', id: 'call-1', args: { prompt: 'new background' } }],
        };
      }
      return { content: '', tool_calls: [] };
    });

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'change background to dark wood' }],
      params: { variantSpec, originalImageIds: [] },
      taskOutput: { payload: { content: { imageUrls: ['https://cdn.example.com/prev.jpg'] } } },
    });

    const content = output.spawnTasks![0]!.input.content as { imageUrls: string[] };
    // New image replaces old
    expect(content.imageUrls).toEqual(['https://cdn.example.com/img-1.jpg']);

    // Reset mock
    toolPassInvokeMock.mockImplementation(async () => ({ content: '', tool_calls: [] }));
    hop = 0;
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/product-designer.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../src/agents/builtin/product-designer/index.js'`

**Step 3: Commit the failing test**

```bash
git add tests/product-designer.test.ts
git commit -m "test(product-designer): add failing tests before implementation"
```

---

### Task 7: Implement product-designer

**Files:**
- Create: `src/agents/builtin/product-designer/index.ts`

**Step 1: Create the implementation**

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { CloudflareImagesClient } from '../../../integrations/cloudflare/images-client.js';
import { getImageById, insertImage } from '../../../integrations/cloudflare/images-repository.js';
import { OpenAIImagesClient } from '../../../integrations/openai-images/client.js';
import { buildImageTools } from '../../../integrations/openai-images/tools.js';
import { buildModel } from '../../../llm/model-registry.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import { runToolLoop } from '../../lib/tool-loop.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
  SpawnTaskRequest,
} from '../../types.js';
import type { ProductContent } from '../product-strategist/content.js';

// NOTE: ProductContent is the contract with shopify-publisher — import from its original
// location so we don't break the publisher when product-strategist is removed.
// After this task, move content.ts to a shared location in Task 8.

const DEFAULT_PROMPT = `You are a Product Designer AI employee for an e-commerce business.
You receive a variant spec from the Product Planner and produce:
1. Images — call images.generate or images.edit based on the imagePlan and any user feedback.
2. Copy — title, HTML description, tags, vendor — tailored to the variant's platform and audience.

Image generation rules:
- The imagePlan lists required and optional shots with purpose and style hints.
- Your packs provide the correct aspect ratios and composition principles per shot type and platform.
- On first run: generate all "required" shots; generate "optional" if the brief supports it.
- On feedback: if user wants image changes, call images.edit with the previously generated URL
  (listed in "Previously generated images") or images.generate for new angles.
- If user feedback is copy-only, do NOT call any image tools.

Copy rules:
- bodyHtml must be safe, well-formed HTML (<p>, <ul>/<li>, <h3>; no <script>/<style>).
- Honor the variant's tone, keyMessages, and featuresToHighlight.
- Use the variant's language for all copy.
- Tags: 3–8 short lower-case keywords.

After tool calls (or if no tools needed), produce the structured listing object.`;

const ProductListingSchema = z.object({
  title: z.string().min(1).max(255),
  bodyHtml: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1).max(20),
  vendor: z.string().min(1),
  productType: z.string().optional(),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe('一句話對老闆回報剛完成什麼。用 zh-TW 第一人稱，對話對象是「老闆」。'),
});

type ProductListing = z.infer<typeof ProductListingSchema>;

const configSchema = z.object({
  defaultVendor: z.string().nullish(),
  defaultLanguage: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']).default('zh-TW'),
  skills: z.object({
    productPhotography: z.boolean().default(true),
    socialMediaImages: z.boolean().default(true),
  }).default({}),
});

type ProductDesignerConfig = z.infer<typeof configSchema>;

export const productDesignerAgent: IAgent = {
  manifest: {
    id: 'product-designer',
    name: 'AI Product Designer',
    description:
      'Generates product images and copy from a variant spec produced by the Product Planner, ' +
      'then spawns publisher agents to distribute to enabled platforms.',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.3 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['images.generate', 'images.edit'],
    requiredCredentials: [],
    configSchema,
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ProductDesignerConfig;

    const publishers = ctx.availableExecutionAgents.filter((a) => a.metadata?.kind === 'publisher');

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks(packsDir, cfg.skills as Record<string, boolean>);

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
      if (publishers.length === 0) {
        throw new Error(
          'no publisher agent available — product-designer requires at least one agent ' +
            'with metadata.kind=publisher to be enabled for the tenant.',
        );
      }

      const variantSpec = input.params.variantSpec as {
        platform?: string;
        language: string;
        marketingAngle: string;
        keyMessages: string[];
        copyBrief: { tone: string; featuresToHighlight: string[]; forbiddenClaims?: string[] };
        imagePlan: { purpose: string; styleHint: string; priority: string }[];
      };

      await ctx.emitLog('agent.started', '收到設計需求，開始畫圖跟寫文', {
        platform: variantSpec?.platform,
        publishers: publishers.map((p) => p.id),
      });

      // --- imageUrls state management ---
      // Priority: previous generated images > original uploaded images > empty
      const previousImageUrls =
        (input.taskOutput?.payload as { content?: { imageUrls?: string[] } } | undefined)
          ?.content?.imageUrls ?? [];

      const imageUrls: string[] = [...previousImageUrls];

      const originalImageIds =
        (input.params as { originalImageIds?: string[] }).originalImageIds ?? [];

      const constraints: string[] = [
        `Variant language: ${variantSpec?.language ?? cfg.defaultLanguage}`,
        `Default vendor: ${cfg.defaultVendor ?? '(must infer from brief)'}`,
      ];

      if (variantSpec?.imagePlan) {
        constraints.push(
          `Image plan:\n${variantSpec.imagePlan
            .map((s) => `- [${s.priority}] ${s.purpose}: ${s.styleHint}`)
            .join('\n')}`,
        );
      }
      if (variantSpec?.copyBrief) {
        constraints.push(`Tone: ${variantSpec.copyBrief.tone}`);
        constraints.push(`Features to highlight: ${variantSpec.copyBrief.featuresToHighlight.join(', ')}`);
        if (variantSpec.copyBrief.forbiddenClaims?.length) {
          constraints.push(`Forbidden claims: ${variantSpec.copyBrief.forbiddenClaims.join(', ')}`);
        }
      }
      if (variantSpec?.keyMessages?.length) {
        constraints.push(`Key messages: ${variantSpec.keyMessages.join(' / ')}`);
      }
      if (previousImageUrls.length > 0) {
        constraints.push(
          `Previously generated images (pass to images.edit to modify): ${previousImageUrls.join(', ')}`,
        );
      }

      // Resolve original uploaded images as reference (not baseline)
      let referenceImageUrls: string[] = [];
      if (originalImageIds.length > 0 && input.imageResolver) {
        referenceImageUrls = await input.imageResolver(originalImageIds);
        if (referenceImageUrls.length > 0) {
          constraints.push(
            `Original reference image(s) — use for style matching or as images.edit source: ${referenceImageUrls.join(', ')}`,
          );
        }
      }

      const systemPrompt = packsBlock ? `${packsBlock}\n\n${ctx.systemPrompt}` : ctx.systemPrompt;
      const baseMessages = await buildAgentMessages(
        systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );

      // Pass 1: image generation tool loop
      let collectedMessages = baseMessages;
      if (imageTools.length > 0) {
        const { collected, calls } = await runToolLoop({
          modelConfig: ctx.modelConfig,
          messages: baseMessages,
          tools: imageTools,
          maxHops: 4,
          emitLog: ctx.emitLog,
        });
        collectedMessages = collected;

        const toolGeneratedUrls = calls
          .map((c) => (c.result as { url?: string }).url)
          .filter((u): u is string => Boolean(u));

        if (toolGeneratedUrls.length > 0) {
          imageUrls.length = 0;
          imageUrls.push(...toolGeneratedUrls);
        }
        // If no tools called: imageUrls retains previousImageUrls (copy-only feedback)
      }

      // Pass 2: structured copy
      const listingModel = buildModel(ctx.modelConfig).withStructuredOutput(ProductListingSchema, {
        name: 'product_listing',
      });
      const listing = (await listingModel.invoke([
        ...collectedMessages,
        new HumanMessage('Now produce the structured product listing.'),
      ])) as ProductListing;

      const content: ProductContent = {
        title: listing.title,
        bodyHtml: listing.bodyHtml,
        tags: listing.tags,
        vendor: listing.vendor,
        productType: listing.productType,
        language: variantSpec?.language ?? cfg.defaultLanguage,
        imageUrls,
        progressNote: listing.progressNote,
      };

      const spawnTasks: SpawnTaskRequest[] = publishers.map((p) => ({
        title: `${listing.title} → ${p.name}`,
        assignedAgent: p.id,
        input: { content },
      }));

      const imageBlock = imageUrls.map((url) => `![商品圖片](${url})`).join('\n');
      const message = [
        `# ${listing.title}`,
        '',
        `**Vendor:** ${listing.vendor}　**Tags:** ${listing.tags.join(', ')}`,
        ...(variantSpec?.platform ? [`**Platform:** ${variantSpec.platform}`] : []),
        '',
        ...(imageBlock ? [imageBlock, ''] : []),
        `_準備送審上架 → ${publishers.map((p) => p.name).join(', ')}_`,
        '',
        '---',
        '',
        '```html',
        listing.bodyHtml,
        '```',
      ].join('\n');

      await ctx.emitLog('agent.content.ready', listing.progressNote, {
        title: listing.title,
        imageCount: imageUrls.length,
        publisherCount: spawnTasks.length,
      });

      return {
        message,
        awaitingApproval: true,
        payload: { content },
        spawnTasks,
      };
    };

    return { tools: imageTools, invoke };
  },
};
```

**Step 2: Run the failing tests**

```bash
pnpm test -- tests/product-designer.test.ts 2>&1 | tail -20
```

Expected: all 3 tests PASS.

**Step 3: Typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: error about missing `product-strategist/content.js` import (since we deleted it).

**Step 4: Commit**

```bash
git add src/agents/builtin/product-designer/index.ts
git commit -m "feat(product-designer): implement execution agent with image loop and feedback round support"
```

---

### Task 8: Move content.ts to shared location + fix imports

The `ProductContent` type was in `product-strategist/content.ts` which is now deleted. Move it to a shared path.

**Files:**
- Create: `src/agents/builtin/shared/content.ts`
- Modify: `src/agents/builtin/product-designer/index.ts` (update import)
- Modify: `src/agents/builtin/shopify-publisher/index.ts` (update import)

**Step 1: Create shared content.ts**

```bash
mkdir -p src/agents/builtin/shared
```

Copy the exact content from the deleted `product-strategist/content.ts`:

```ts
/**
 * Platform-agnostic product content produced by product-designer and
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

**Step 2: Update imports in product-designer**

Change:
```ts
import type { ProductContent } from '../product-strategist/content.js';
```
To:
```ts
import type { ProductContent } from '../shared/content.js';
```

**Step 3: Update imports in shopify-publisher**

Change:
```ts
import type { ProductContent } from '../product-strategist/content.js';
```
To:
```ts
import type { ProductContent } from '../shared/content.js';
```

**Step 4: Typecheck — should be clean**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: no errors.

**Step 5: Run all tests**

```bash
pnpm test 2>&1 | tail -10
```

Expected: all pass.

**Step 6: Commit**

```bash
git add src/agents/builtin/shared/content.ts \
        src/agents/builtin/product-designer/index.ts \
        src/agents/builtin/shopify-publisher/index.ts
git commit -m "refactor: move ProductContent to shared/content.ts — decoupled from deleted product-strategist"
```

---

### Task 9: Final verification

**Step 1: Run full test suite**

```bash
pnpm test:all 2>&1 | tail -15
```

Expected: all unit + integration tests pass.

**Step 2: Typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: clean.

**Step 3: Lint**

```bash
pnpm lint 2>&1 | tail -5
```

**Step 4: Commit if any lint fixes were needed, then final commit**

```bash
git add -A
git commit -m "feat: replace product-strategist with product-planner + product-designer

- product-planner: strategy agent, serper research, spawns designer variants
- product-designer: image tool loop + structured copy, feedback round image preservation
- shared/content.ts: ProductContent type moved to shared location
- skill packs: product-positioning, ecommerce-marketing, product-photography, social-media-images"
```
