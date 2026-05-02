# Product Publisher Agents — Design

**Status:** Approved (brainstorm 2026-05-02)
**Scope:** Replace `shopify-ops` with a platform-agnostic `product-strategist` + a lean `shopify-publisher`, decoupling content/image generation from platform publishing.

## Motivation

`shopify-ops` mixes two concerns: generating platform-agnostic product content (copy + images) and publishing to Shopify. As the platform expands to WooCommerce, WordPress, social media, etc., this coupling makes each new platform require a full new agent with duplicate content-generation logic. By splitting content creation from publishing, new platforms only need a thin publisher agent.

## Non-Goals (v1)

- WooCommerce / WordPress / social publishers
- Publisher-level LLM iteration (boss cannot give `/feedback` to the publisher to revise copy — must discard and re-run Strategist)
- Competitor/trend research (no Serper calls)
- Multi-platform spawn from one brief (Strategist spawns only available publishers)

## Architecture

### Agent topology

```
product-strategist (kind='strategy')
  ├─ input:  brief + task.input.imageIds (user-uploaded images)
  ├─ 1. LLM (withStructuredOutput) generates ProductContent from brief + vision
  ├─ 2. Code: edit uploaded images OR generate new images → CF Images
  ├─ 3. Assembles spawnTasks for each available publisher in availableExecutionAgents
  ├─ waiting → boss approves → finalizeStrategyTask → spawn children
  └─ shopify-publisher (execution)
        ├─ input: { content: ProductContent }
        ├─ invoke(): NO LLM — pure mapping → pendingToolCall
        ├─ waiting → boss reviews product preview
        └─ approve(finalize) → shopify.create_product → done

shopify-ops → DELETED (no alias, no backward compat — product not live yet)
```

### Platform selection logic

`product-strategist` inspects `ctx.availableExecutionAgents` at runtime. For v1 with only `shopify-publisher` registered, it always spawns one child. When future publishers are added (WooCommerce, Threads, etc.), the Strategist uses the brief text + available agents to decide which to spawn — or spawns all of them.

## Schemas

### `ProductContent` — shared data contract

```ts
// src/agents/builtin/product-strategist/content.ts
export interface ProductContent {
  title: string;          // product name, max 255
  bodyHtml: string;       // HTML description
  tags: string[];         // 3–8 keywords
  vendor: string;
  productType?: string;
  language: string;       // zh-TW | en | ja
  imageUrls: string[];    // CF Images public URLs (already uploaded)
  progressNote: string;   // agent's first-person report for the kanban timeline
}
```

This type lives in `product-strategist/content.ts` and is imported by all publisher agents. It is the contract — changing it requires updating all publishers.

### `product-strategist` configSchema

```ts
z.object({
  defaultLanguage: z.enum(['zh-TW', 'en', 'ja']).default('zh-TW'),
  defaultVendor: z.string().nullish(),
  images: z.object({
    autoGenerate: z.boolean().default(true),
    style: z.string().nullish(),
  }).default({}),
  skills: z.object({
    seoFundamentals: z.boolean().default(true),
    // future: brandVoice, styleGuide — loaded as markdown packs
  }).default({}),
})
```

`requiredCredentials`: none (images use platform-wide env vars, not tenant credentials).

### `shopify-publisher` configSchema

```ts
z.object({
  shopify: z.object({
    credentialLabel: z.string().nullish(),
    autoPublish: z.boolean().default(false),
  }).default({}),
})
```

`requiredCredentials`: `shopify`.

### LLM structured output (Strategist internal)

```ts
const ProductListingSchema = z.object({
  title: z.string().min(1).max(255),
  bodyHtml: z.string().min(1),
  tags: z.array(z.string()).min(1).max(20),
  vendor: z.string().min(1),
  productType: z.string().optional(),
  progressNote: z.string().min(10).max(200),
});
// language comes from cfg.defaultLanguage (injected by code, not LLM)
// imageUrls come from image generation step (injected by code, not LLM)
```

## Data flow

```
1. Boss POST /v1/tasks { brief: "幫我上架這件亞麻衫" }
   task.input = { brief, imageIds?: ['uuid-1'] }

2. Supervisor routes → product-strategist

3. product-strategist invoke()
   a. Vision: if imageIds present, imageResolver resolves UUIDs → CF URLs
      → passed to buildAgentMessages() as image_url content blocks
   b. LLM call → ProductListingSchema (title, bodyHtml, tags, vendor, progressNote)
   c. Image step (in code, not LLM tool call):
        - imageIds present + style set → images.edit(imageId, stylePrompt)
        - imageIds absent + autoGenerate=true → images.generate(titleBasedPrompt)
        - imageIds present + no style → use as-is (resolve UUIDs → URLs)
   d. Assemble ProductContent = { ...listing, language: cfg.defaultLanguage, imageUrls }
   e. spawnTasks = availableExecutionAgents
        .filter(a => KNOWN_PUBLISHER_IDS.includes(a.id))
        .map(a => ({
          title: `${listing.title} → ${a.name}`,
          assignedAgent: a.id,
          input: { content: ProductContent },
        }))
   f. return { message: summaryMarkdown, awaitingApproval: true, spawnTasks }

4. task → waiting
   Boss sees: ProductContent summary + "approve to spawn N publisher tasks"

5. approve(finalize=true)
   → finalizeStrategyTask → spawn shopify-publisher child

6. shopify-publisher invoke()
   a. const content = input.params.content as ProductContent
   b. Pure mapping → pendingToolCall: shopify.create_product
   c. return { message: renderProductPreview(content), awaitingApproval: true, pendingToolCall }
   (NO LLM CALL)

7. task → waiting
   Boss sees: Shopify product preview markdown

8. approve(finalize=true)
   → tool-executor → shopify.create_product (with images) → done
```

## Publisher pattern (no-LLM agent)

`shopify-publisher` is intentionally LLM-free. It reads structured `ProductContent` from `task.input.params.content`, maps it to the Shopify tool args, and returns a HITL gate. The `build()` method only constructs Shopify tools — no model is built.

```ts
async build(ctx): AgentRunnable {
  const cfg = configSchema.parse(ctx.agentConfig ?? {});
  const tools = await buildShopifyTools(ctx.tenantId, { ...cfg.shopify });
  const filtered = tools.filter(t => t.id === 'shopify.create_product');
  return {
    tools: filtered,
    invoke: async (input) => {
      const content = input.params.content as ProductContent;
      const pendingToolCall = {
        id: 'shopify.create_product',
        args: {
          title: content.title,
          bodyHtml: content.bodyHtml,
          tags: content.tags,
          vendor: content.vendor,
          images: content.imageUrls.map(url => ({ url })),
        },
      };
      await ctx.emitLog('agent.ready', content.progressNote, { title: content.title });
      return {
        message: renderProductPreview(content, cfg.shopify.autoPublish),
        awaitingApproval: true,
        payload: { content },
        pendingToolCall,
      };
    },
  };
}
```

## Files to create / modify / delete

**Create:**
- `src/agents/builtin/product-strategist/index.ts`
- `src/agents/builtin/product-strategist/content.ts` (ProductContent type)
- `src/agents/builtin/product-strategist/packs/seo-fundamentals.md` (copy from shopify-ops)
- `src/agents/builtin/shopify-publisher/index.ts`

**Modify:**
- `src/agents/index.ts` — register new agents, remove shopify-ops
- `src/integrations/shopify/tools.ts` — no change needed (shopify-publisher imports SHOPIFY_TOOL_IDS directly)

**Delete:**
- `src/agents/builtin/shopify-ops/index.ts`
- `src/agents/builtin/shopify-ops/` (whole directory)
- `tests/shopify-ops.test.ts`
- `tests/integration/shopify-ops.test.ts`

## Brand tone/style extension point

`product-strategist` config has `skills: { seoFundamentals, ... }`. Future brand voice and style guide packs load as markdown files in `packs/`:

```
src/agents/builtin/product-strategist/packs/
  seo-fundamentals.md    ← ship in v1
  brand-voice.md         ← user provides later
  style-guide.md         ← user provides later
```

No code change required when adding new packs — just drop the file in and enable the key in `cfg.skills`.

## Testing strategy

| Layer | What |
|---|---|
| Unit | `ProductListingSchema` Zod validation |
| Unit | `renderProductPreview()` output format |
| Unit | `shopify-publisher.invoke()` — assert NO model is built, pendingToolCall maps content correctly |
| Unit | `product-strategist` — mock LLM + mock image tools → assert spawnTasks contains correct content |
| Integration | Full flow: brief + imageId → Strategist waiting → approve → spawn publisher → publisher waiting → approve → `shopify.create_product` called with images |
| Delete | All existing `shopify-ops` unit + integration tests |

## Risks

- **KNOWN_PUBLISHER_IDS maintenance**: Strategist must know which agent IDs are publishers (not all execution agents are publishers). Use a manifest flag: `metadata.kind = 'publisher'` — Strategist filters `availableExecutionAgents` by this flag rather than a hardcoded list.
- **Empty publisher list**: If no publisher agents are enabled, Strategist should throw at build time (same as seo-strategist's worker check).
- **ProductContent schema drift**: If `shopify-publisher` expects a field that `product-strategist` doesn't produce, the child task fails silently. Mitigation: share the `ProductContent` TypeScript type via import, validated with Zod in the publisher's `invoke()`.
