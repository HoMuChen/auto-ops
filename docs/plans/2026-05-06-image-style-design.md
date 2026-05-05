# Tenant Image Style — Design

**Date:** 2026-05-06
**Status:** Approved, ready for implementation plan
**Depends on:** `feat/tenant-knowledge-layer` (uses `getTenantProfile` repository, follows the same Layer 1 structured-field pattern as `timezone`)

## Problem

Image-generation tools (`images.generate`, `images.edit`) currently accept whatever prompt the LLM emits. There is no tenant-level visual style anchor. Every product photo, blog cover, and social asset can drift in lighting, palette, composition. Tenants who want "all our images look like X" have no way to enforce it.

The agent-local `shopify-blog-writer.coverImageStyle` covers exactly one case (one agent, one image). The `product-designer` agent has no equivalent. Even if both grew their own field, that recreates the per-agent duplication the tenant knowledge layer just eliminated.

## Goals

- One tenant-level visual style that **deterministically** anchors every image-generation call across all agents.
- AI-assisted authoring: user uploads 1–5 reference images, system generates a suggested style suffix, user edits and saves.
- Persist references so the user can re-generate the suffix later (or feed them to a future style-transfer mechanism without re-uploading).

## Non-goals

- **Named multi-preset styles** (`product-hero` / `lifestyle` / `blog-cover`). Single tenant-wide suffix in V1; if multi-preset becomes load-bearing, upgrade to a `tenant_image_styles` table later.
- **Reference image style transfer** (gpt-image-1 `image` parameter feeding the model directly). This is Option C in the brainstorm; defer until Option B (text suffix) is shipped and validated.
- **Auto-suggest on every PUT.** Each suggest call costs a vision LLM round-trip; user must explicitly trigger it.
- **Suffix version history / diff.** User edits overwrite the previous value.

## Architecture

One structured field carrying the deterministic anchor + a sibling array carrying the references that produced it + an AI helper endpoint to bootstrap the field.

```
┌───────────────────────────────────────────────────────┐
│  tenants table (Layer 1 structured fields)            │
│    timezone TEXT                                       │
│    image_style_suffix TEXT          ← new             │
│    image_style_reference_image_ids UUID[]   ← new     │
│  profile_md TEXT (Layer 1 markdown — unchanged)       │
└───────────────────────────────────────────────────────┘
                  ↓ read by
┌───────────────────────────────────────────────────────┐
│  buildImageTools (tool-boundary injection)            │
│                                                        │
│   final_prompt = llm_prompt                            │
│                + "\n\nStyle: " + tenant.suffix         │
│                                                        │
│  → OpenAI gpt-image-1 → CF Images → tenant_images     │
└───────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────┐
│  POST /v1/profile/image-style/suggest                 │
│    body: { referenceImageIds, hint? }                  │
│    → vision LLM (Claude Sonnet via OpenRouter)         │
│    → { suggestedSuffix: string }                       │
│                                                        │
│  GET / PUT /v1/profile  ← extended response/body       │
│    + imageStyleSuffix                                  │
│    + imageStyleReferenceImageIds                       │
└───────────────────────────────────────────────────────┘
```

**Invariants:**

- `image_style_suffix` is the **only** value read at tool boundary. Reference images are inputs to the suggest helper, not consumed by image generation itself.
- Empty suffix (default) → no behavior change. Existing tenants don't suddenly start producing differently-styled images.
- agent-local style fields (e.g. `shopify-blog-writer.coverImageStyle`) stay; they layer on top as scene-specific notes.

## Data model

### Migration `0008_image_style.sql`

```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS image_style_suffix TEXT NOT NULL DEFAULT '';

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS image_style_reference_image_ids UUID[] NOT NULL DEFAULT '{}';
```

Pure additive; no carry-forward; idempotent on re-run via `IF NOT EXISTS`.

### Drizzle schema (`src/db/schema/tenants.ts`)

Add to the existing `pgTable('tenants', {...})`:

```ts
imageStyleSuffix: text('image_style_suffix').notNull().default(''),
imageStyleReferenceImageIds: uuid('image_style_reference_image_ids')
  .array().notNull().default([]),
```

### Validation

| Field | Rule | Reason |
|---|---|---|
| `imageStyleSuffix` | ≤ 2 KB | Goes into every image prompt — large strings waste tokens and confuse the image model |
| `imageStyleReferenceImageIds` | 0–5 entries | Vision LLMs degrade past ~5 reference images; OpenAI vision practical cap |
| Each `imageStyleReferenceImageIds[i]` | Must exist in `tenant_images` AND `tenant_id == request tenant` | IDOR guard (analogous to skill-packs CRUD) |

No new table. Reference images already live in `tenant_images` via the existing `POST /v1/uploads` endpoint.

## Tool-boundary injection

### `src/integrations/openai-images/tools.ts`

`BuildImageToolsOpts` gains an optional `styleSuffix` field. Both `generate` and `edit` tool implementations append the suffix to the LLM-supplied prompt before calling OpenAI:

```ts
export interface BuildImageToolsOpts {
  // ... existing fields
  /** Tenant-level style suffix appended to every prompt. Empty = no-op. */
  styleSuffix?: string;
}

// inside the generate tool body:
const finalPrompt = opts.styleSuffix
  ? `${input.prompt}\n\nStyle: ${opts.styleSuffix}`
  : input.prompt;
const buffer = await opts.openaiClient.generate({ prompt: finalPrompt, ... });
```

`edit` follows the same pattern. The factory itself stays pure (no DB access); the call sites supply `styleSuffix`.

### Call-site updates

Both image-generating agents fetch the suffix at `build()` time and pass it through:

- `src/agents/builtin/product-designer/index.ts` — already calls `getTenantProfile`-style data via `ctx`. Read `imageStyleSuffix` from a profile read; pass into `buildImageTools`.
- `src/agents/builtin/shopify-blog-writer/index.ts` — same. Cover-image generation continues to layer `cfg.coverImageStyle` (scene) on top of the LLM prompt; the wrapper then appends the tenant style:

```text
LLM prompt:    "Blog cover image for: '<title>'. <coverImageStyle>"
Wrapper adds:  "\n\nStyle: <tenant.imageStyleSuffix>"
```

## API surface

### Extend `GET /v1/profile`

Response shape grows by two fields:

```json
{
  "profileMd": "...",
  "timezone": "Asia/Taipei",
  "imageStyleSuffix": "Editorial product photography. ...",
  "imageStyleReferenceImageIds": ["uuid-1", "uuid-2"]
}
```

### Extend `PUT /v1/profile`

Body accepts the two new optional fields with the validation rules above. Partial-update semantics preserved (existing fields untouched if not in body).

### New `POST /v1/profile/image-style/suggest`

```
body: {
  referenceImageIds: string[],   // 1–5; each must belong to caller's tenant
  hint?: string                  // optional, e.g. "more editorial, less commercial"
}
→ 200 { suggestedSuffix: string }
→ 400 if any imageId is missing or belongs to another tenant
→ 400 if referenceImageIds.length is 0 or > 5
```

Implementation:

1. Resolve each `imageId` → `tenant_images` row, scoped by `tenantOf(req)`. Fail 400 on any miss.
2. Build LangChain message array with image URLs (OpenRouter accepts vision messages with `image_url` content blocks).
3. Call `buildModel({ model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 }).withStructuredOutput(z.object({ suffix: z.string() }))`.
4. Return the structured suffix.

**Vision system prompt** (canonical text, lives in the route file or a sibling const):

> You extract visual style guidelines from a brand's reference images. Output ONE dense prose paragraph (80–200 words) capturing: photography genre (editorial / product / lifestyle / studio), lighting (direction, quality), color palette and mood, composition rules (centered / rule-of-thirds / copy space), background, props and models, finish (clean / film grain). The output will be appended verbatim to image-generation prompts — write it as instructions to an image model. No headings, no bullets, no quote marks. One paragraph only.

Suggest does **not** auto-write the suffix. UI receives the suggestion, user reviews/edits, then calls `PUT /v1/profile`.

## Testing strategy

Conventions: unit tests stay DB-free; integration tests run on local Supabase; `fetch` to OpenAI is stubbed; OpenRouter is mocked through `llmMockModule`.

### Unit (`tests/`)

- `openai-images-tools.test.ts` — extend with cases:
  - `styleSuffix` undefined → prompt unchanged
  - `styleSuffix` non-empty → final prompt has `\n\nStyle: ` separator
  - same for `edit` tool
- `image-style-validation.test.ts` — Zod schema rejects:
  - 2 KB + 1 byte suffix
  - 6 referenceImageIds
  - empty referenceImageIds in suggest body

### Integration (`tests/integration/`)

- `image-style-api.integration.test.ts`:
  - PUT/GET round-trips both new fields
  - PUT with `imageStyleReferenceImageIds` containing another tenant's image uuid → 400 (IDOR guard)
  - PUT with 6 references → 400
  - suggest endpoint with mock vision response → returns `suggestedSuffix`
  - suggest with cross-tenant imageId → 400
- `image-style-e2e.integration.test.ts`:
  - Set `tenants.image_style_suffix = '<UNIQUE_MARKER>'`
  - Spy on `OpenAIImagesClient.prototype.generate`
  - Run a product-designer task that triggers `images.generate`
  - Assert the prompt argument captured by the spy contains `<UNIQUE_MARKER>`

### Existing tests

- `tests/integration/uploads.test.ts` — unchanged; reference images use the existing upload path.
- `tests/integration/tenant-profile-api.integration.test.ts` (Task 10 from prior branch) — extend round-trip assertion to include the two new fields.

## Deploy order

1. Run migration `0008_image_style.sql`.
2. Deploy code: schema, repository extension, tools wrapper, route extensions, suggest endpoint.
3. UI team consumes the extended `PUT /v1/profile` surface + new `POST /v1/profile/image-style/suggest`.

No data backfill — all existing tenants get `''` and `'{}'` as defaults, which means **no behavior change** until they explicitly set a suffix. Non-breaking rollout.

## Open questions / future work

- **Option C (style-transfer via reference images).** When OpenAI gpt-image-1's `image` parameter (or successor) becomes reliable, `images.edit` can use `imageStyleReferenceImageIds[0]` as the source for actual visual anchoring. Schema already supports this — no migration needed.
- **Multi-preset styles** (`tenant_image_styles` table). Convert `image_style_suffix TEXT` into `default_style_id UUID FK → tenant_image_styles.id`. One-line schema migration; agent picks by name. Defer until a tenant actually needs it.
- **Suffix length tuning.** 2 KB is a first guess. May want to bump to 4 KB if real tenants find the cap restrictive, or shrink to 512 bytes if image models perform worse with long suffixes. Empirical, post-launch.
- **Per-agent suffix override.** Today only `coverImageStyle` exists. If product-designer wants per-task scene notes, that's the same pattern (agent-local string, tool wrapper appends after). No design change needed; it's just another caller.
