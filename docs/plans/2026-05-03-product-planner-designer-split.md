# Design: Split product-strategist into product-planner + product-designer

Date: 2026-05-03

## Background

`product-strategist` currently does everything in one agent: marketing planning, image generation, and copy writing. The goal is to split it into two distinct agents with clear responsibilities — a planner with marketing domain knowledge and a designer that executes the creative work.

## Decision

Delete `product-strategist`. Replace with:

- **`product-planner`** — strategy agent, marketing domain knowledge, researches competitors via Serper, spawns designer tasks
- **`product-designer`** — execution agent, image generation + copywriting, spawns publisher tasks

`shopify-publisher` is unchanged.

## Execution Chain

```
user brief
  → product-planner (strategy)
      serper research + marketing planning
      spawn: product-designer task × N variants
  → product-designer (execution → auto-promoted strategy)
      Pass 1: images.generate / images.edit tool loop
      Pass 2: structured copy (title, bodyHtml, tags, vendor)
      spawn: shopify-publisher task(s)
  → shopify-publisher (unchanged)
      create product on Shopify
```

## product-planner

**Manifest:**
- id: `product-planner`
- kind: `strategy`
- model: `anthropic/claude-opus-4.7` (temp 0.2)
- tools: `serper_search`
- requiredCredentials: none

**configSchema:**
```ts
{
  maxVariants: number          // 1–10, default 5
  defaultLanguages: string[]   // default ['zh-TW']
  brandTone: string?
  preferredKeywords: string[]
  useSerperSearch: boolean     // default true
  skills: {
    seoFundamentals: boolean       // default true
    productPositioning: boolean    // default true
    ecommerceMarketing: boolean    // default true
  }
}
```

**Structured output — DesignerVariantSchema (per spawn):**
```ts
{
  title: string               // e.g. "夏季主打款 - 繁中電商版"
  platform?: string           // "shopify" | "instagram" | ...
  language: enum
  marketingAngle: string      // e.g. "強調機能透氣，針對台灣濕熱夏天通勤族"
  keyMessages: string[]
  copyBrief: {
    tone: string
    featuresToHighlight: string[]
    forbiddenClaims?: string[]
  }
  imagePlan: [{
    purpose: string           // "hero shot" | "lifestyle - 通勤場景" | "detail - 布料紋路"
    styleHint: string         // "clean white background" | "warm morning light"
    priority: "required" | "optional"
  }]
  assignedAgent: "product-designer"
  scheduledAt?: string
}
```

Planner decides: variant count, purpose, and style direction per image.
Planner does NOT decide: ratio, composition details, or generation prompts — those belong to the designer's domain knowledge (packs).

**Spawn:** one `product-designer` task per variant. `input.params = { variantSpec, originalImageIds }` — original uploaded image IDs are forwarded so the designer can use them as reference.

**Skill packs:**
- `product-positioning.md` — USP mining, competitive differentiation, audience segmentation
- `ecommerce-marketing.md` — content angle types, multi-platform strategy, conversion copy principles
- `seo-fundamentals.md` — keyword awareness (copied from existing)

## product-designer

**Manifest:**
- id: `product-designer`
- kind: `execution` (auto-promoted to `strategy` by the runner when spawnTasks is set)
- model: `anthropic/claude-sonnet-4.6` (temp 0.3)
- tools: `images.generate`, `images.edit`
- requiredCredentials: none (image tools require env vars, not tenant credentials)

**configSchema:**
```ts
{
  defaultVendor: string?
  defaultLanguage: enum       // default 'zh-TW'
  skills: {
    productPhotography: boolean    // default true
    socialMediaImages: boolean     // default true
  }
}
```

**imageUrls state management across feedback rounds:**

```
First run:
  originalImageIds present → resolve → pass as reference in constraints
  imageUrls starts empty (LLM generates from scratch)

Feedback re-run:
  taskOutput.payload.content.imageUrls present → initialize imageUrls with these
  originalImageIds → separately passed as reference in constraints

After Pass 1 (tool loop):
  toolGeneratedUrls non-empty → replace imageUrls entirely
  toolGeneratedUrls empty     → imageUrls unchanged (copy-only feedback)
```

**Constraints passed to LLM in Pass 1:**
- `variantSpec.imagePlan` — purpose + styleHint per image
- `Previously generated images: [urls]` — available for `images.edit`
- `Original reference image: [url]` — style reference
- Pack knowledge provides: ratio selection, composition principles, prompt construction

**Pass 2 structured output:**
```ts
{
  title: string
  bodyHtml: string     // safe HTML
  tags: string[]
  vendor: string
  productType?: string
  progressNote: string
}
```

No `summary` field — that is the planner's responsibility.

**Spawn:** `shopify-publisher` task(s), same pattern as the old product-strategist.

**Skill packs:**
- `product-photography.md` — listing image types (1:1 hero, 4:5 lifestyle, detail shots), group shot logic (3–5 images per listing), composition principles
- `social-media-images.md` — Instagram (1:1, 4:5, 9:16 Stories), Facebook (1.91:1), safe zones, composition focus per ratio

## File Structure

```
src/agents/builtin/
  product-planner/
    index.ts
    packs/
      product-positioning.md
      ecommerce-marketing.md
      seo-fundamentals.md
  product-designer/
    index.ts
    packs/
      product-photography.md
      social-media-images.md
  product-strategist/          ← DELETE
```

`src/agents/index.ts` — remove productStrategistAgent, add productPlannerAgent + productDesignerAgent.

## What is NOT changing

- `shopify-publisher` — unchanged
- `runToolLoop` helper — used as-is by product-designer
- `ProductContent` type — reused by product-designer → shopify-publisher
- Task spawn / finalize / approve mechanics — no framework changes needed
