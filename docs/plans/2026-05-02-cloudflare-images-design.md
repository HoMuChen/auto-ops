# Cloudflare Images Integration — Design

**Status:** Approved (brainstorm 2026-05-02)
**Scope:** Image upload (user-initiated), AI image generation (agent-driven), vision capability for agents, Shopify product/article image attachment.

## Goal

Fix the regression noted in CLAUDE.md ("agents currently produce text-only") by wiring Cloudflare Images as the CDN layer for all tenant images: user uploads, AI-generated product images, and blog cover images.

## Non-Goals (v1)

- CF Images variant management UI (variants served via URL suffix, no DB tracking needed)
- Per-tenant image quota enforcement (query `COUNT(*)` when needed later)
- Image browsing/library UI
- Background removal / inpainting (edit API covers basic cases; advanced tools are v2)
- Video or non-image file uploads

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Image generation provider | **OpenAI gpt-image-1** (direct `OPENAI_API_KEY`) | User preference; stable API, good prompt following |
| User upload mechanism | **Proxy via `/v1/uploads`** | Simple; backend can validate MIME/size/tenant; <10MB product images fit fine |
| Image storage model | **`tenant_images` table (first-class entity)** | Long-term: image reuse, async status, cleanup, quota, library. JSONB-only would require costly migration later |
| Vision capability | **Auto-inject image_url blocks in `buildAgentMessages`** | Agent doesn't need to opt in; any agent receiving a message with imageIds gets vision automatically |
| Shopify-ops image flow | **Single HITL gate** (listing copy + images together) | Boss judges the full product page; one approval vs two |
| Blog cover image | **`generateCoverImage: boolean` config toggle** (default `true`) | Consistent with existing `publishToShopify`/`publishImmediately` pattern |
| Shopify-ops: user original image | **Use as-is when boss says so, skip generation** | Agent detects `input.imageIds` + user instruction; no redundant API call |

## Architecture

### Two entry paths, one table

```
── Path A: User Upload ──────────────────────────────────────
Browser (multipart/form-data)
  → POST /v1/uploads  (requireAuth + requireTenant)
  → Validate: MIME ∈ {jpeg,png,webp,gif}, size ≤ 10 MB
  → CloudflareImagesClient.upload(buffer)
  → INSERT tenant_images (sourceType='uploaded', status='ready')
  → 200 { id, url }

Client stores id in:
  messages.data.imageIds[]        (task conversation attachment)
  IntakeMessage.imageIds[]        (intake conversation attachment)
  tasks.input.imageIds[]          (image attached at task creation)

── Path B: Agent Generation ─────────────────────────────────
Agent calls images.generate(prompt) or images.edit(sourceImageId, prompt)
  → OpenAIImagesClient  →  Buffer
  → CloudflareImagesClient.upload(buffer)
  → INSERT tenant_images (sourceType='generated'/'edited', status='ready')
  → returns { id, url }

Agent puts id(s) in output payload / pendingToolCall.args.images[]

── Vision ───────────────────────────────────────────────────
buildAgentMessages() — when message.data.imageIds present:
  resolve UUIDs → CF urls via tenant_images lookup
  emit LangChain content array:
    [{ type:'image_url', image_url:{ url } }, { type:'text', text:... }]
  Agents get vision automatically; no opt-in required
```

**UUID refs everywhere, never raw URLs** — CF URL prefix is derived from `tenant_images` at query time. Changing CDN domain or variant format touches one place.

## DB Schema

### New: `tenant_images`

```ts
// src/db/schema/images.ts
tenant_images(
  id              uuid PK  defaultRandom()
  tenant_id       uuid  NOT NULL  FK → tenants (cascade)
  cf_image_id     text  NOT NULL          // Cloudflare Images imageId
  url             text  NOT NULL          // base delivery URL (no variant suffix)
  source_type     enum('uploaded','generated','edited')  NOT NULL
  status          enum('pending','ready','failed')  NOT NULL  default 'ready'
  prompt          text                    // set for generated/edited
  source_image_id uuid  FK → tenant_images  // for edits/variations
  task_id         uuid  FK → tasks  (nullable)  // traceability
  mime_type       text
  file_size       int
  created_by      uuid  FK → users  (nullable)
  created_at      timestamp tz  defaultNow()
)

indexes:
  (tenant_id, created_at)     -- image library list
  (task_id)                   -- all images for a task
  (source_image_id)           -- all derivatives of an original
```

### Changes to existing types (zero DB migrations)

**`messages.data`** — type annotation only:
```ts
data: jsonb('data').$type<{ imageIds?: string[]; [key: string]: unknown }>()
```

**`IntakeMessage`** — add optional field:
```ts
export type IntakeMessage = {
  role: IntakeMessageRole;
  content: string;
  createdAt: string;
  imageIds?: string[];
};
```

**`TaskOutput`** — add to `src/tasks/output.ts`:
```ts
generatedImageIds?: string[];  // UUIDs of agent-generated images
```

## New Components

### `src/integrations/cloudflare/images-client.ts`

Thin wrapper around CF Images REST API (`POST /accounts/{accountId}/images/v1`, multipart).

```ts
class CloudflareImagesClient {
  async upload(buffer: Buffer, opts: {
    filename: string;
    mimeType: string;
    metadata?: Record<string, string>;
  }): Promise<{ cfImageId: string; url: string }>
}
```

URL format: `https://imagedelivery.net/{CLOUDFLARE_IMAGES_HASH}/{cfImageId}/public`

`CLOUDFLARE_IMAGES_HASH` is a new env var (the account hash returned in CF Images responses, distinct from `CLOUDFLARE_ACCOUNT_ID`).

### `src/integrations/openai-images/client.ts`

```ts
class OpenAIImagesClient {
  // uses OPENAI_API_KEY env var, model: gpt-image-1
  async generate(opts: {
    prompt: string;
    size?: '1024x1024' | '1792x1024' | '1024x1792';
    quality?: 'standard' | 'hd';
  }): Promise<Buffer>

  async edit(opts: {
    imageBuffer: Buffer;
    prompt: string;
    size?: '1024x1024';
  }): Promise<Buffer>
}
```

### `src/integrations/openai-images/tools.ts`

```ts
buildImageTools(tenantId: string, opts: {
  cfClient: CloudflareImagesClient;
  openaiClient: OpenAIImagesClient;
  taskId?: string;
}): AgentTool[]
```

| Tool id | Behaviour |
|---|---|
| `images.generate` | prompt → OpenAI → CF upload → INSERT tenant_images → `{ id, url }` |
| `images.edit` | sourceImageId → fetch CF image → OpenAI edit → CF upload → INSERT → `{ id, url }` |

No HITL gate on these tools — agent calls them internally; the containing task's existing gate (listing / article approval) is where the boss reviews.

### `src/api/routes/uploads.ts`

```
POST /v1/uploads
Auth: requireAuth + requireTenant
Body: multipart/form-data  { file, context?: 'message'|'task' }

Validation:
  MIME: image/jpeg | image/png | image/webp | image/gif
  Size: ≤ 10 MB

Flow:
  CloudflareImagesClient.upload()
  → INSERT tenant_images (sourceType='uploaded', status='ready')
  → 200 { id, url }
```

Registered in `src/api/routes/index.ts`.

## Agent Changes

### Shopify Ops

Config schema additions:
```ts
images: z.object({
  autoGenerate: z.boolean().default(true),
  style: z.string().nullish()
    .describe('Style hint, e.g. "clean white background, product photography"'),
}).default({})
```

`build()` wires `buildImageTools()` into `tools[]`.

`invoke()` logic:
```
input.imageIds present
  + boss says "use as-is"  → pull url from tenant_images, pass to pendingToolCall
  + needs variations        → call images.edit(sourceImageId, prompt)

input.imageIds absent + cfg.images.autoGenerate=true
  → call images.generate(prompt derived from listing title/type/style)

pendingToolCall.args.images = [{ url }]
```

`shopify.create_product` tool: add `images?: { url: string }[]` parameter, included in Shopify Admin API product POST.

### Blog Writer

Config schema additions:
```ts
generateCoverImage: z.boolean().default(true),
coverImageStyle: z.string().nullish(),
```

Stage 2 (draft complete), if `generateCoverImage=true`:
```ts
const cover = await images.generate({
  prompt: `Blog cover image for: "${article.title}". ${cfg.coverImageStyle ?? 'Clean editorial style.'}`,
});
pendingToolCall.args.coverImageUrl = cover.url;
```

`shopify.publish_article` tool: add `coverImageUrl?: string`, included in Shopify Blog API article POST as `image.src`.

## Vision — `buildAgentMessages` update

```ts
export async function buildAgentMessages(
  systemPrompt: string,
  history: AgentInput['messages'],
  constraints?: readonly string[],
  imageResolver?: (imageIds: string[]) => Promise<string[]>,
): Promise<BaseMessage[]>
```

When `message.imageIds` is non-empty and `imageResolver` is provided:
```ts
// Instead of: new HumanMessage(content: string)
// Emit:       new HumanMessage(content: [
//   { type: 'image_url', image_url: { url: resolvedUrl } },
//   { type: 'text', text: message.content }
// ])
```

`imageResolver` is injected from `graph.ts` agent node — queries `tenant_images` by UUID array. Agents that don't pass a resolver gracefully degrade (image refs ignored).

`AgentInput.messages` type gains:
```ts
{ role: ...; content: string; imageIds?: string[] }
```

`graph.ts` populates `imageIds` from the GraphState message metadata when building the agent input.

## New Env Vars

```
OPENAI_API_KEY=               # OpenAI image generation (gpt-image-1)
CLOUDFLARE_IMAGES_HASH=       # CF Images account hash (from upload response)
```

Existing `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_IMAGES_TOKEN` unchanged.

## Testing Strategy

| Layer | What |
|---|---|
| Unit | `CloudflareImagesClient`: mock fetch, assert multipart body + parse cfImageId/url from response |
| Unit | `OpenAIImagesClient`: mock fetch, assert request shape for generate + edit; returns Buffer |
| Unit | `images.generate` tool: mock CF + OpenAI clients; assert tenant_images INSERT + returned id/url |
| Unit | `images.edit` tool: mock CF download + OpenAI + CF upload; assert source_image_id FK set |
| Unit | `buildAgentMessages` with imageIds + resolver: assert content becomes image_url array |
| Unit | `POST /v1/uploads`: MIME validation rejects non-image; size limit; happy path mocks CF |
| Integration | `POST /v1/uploads` → mock CF → assert `tenant_images` row created with sourceType='uploaded' |
| Integration | shopify-ops with `input.imageIds` → mock images.edit + mock Shopify → assert `create_product` called with `images` |
| Integration | blog-writer Stage 2 with `generateCoverImage=true` → mock `images.generate` → assert `pendingToolCall.args.coverImageUrl` set |

No real CF or OpenAI calls in any test — stub fetch exactly as Serper and Shopify tools do.

## Risks / Mitigations

- **CF Images account hash bootstrapping**: first upload returns the hash; if env var missing, client throws clearly. Seed it from first manual upload or CF dashboard.
- **OpenAI image generation latency (5–15s)**: runs synchronously inside the agent tool call. Acceptable for v1 (task is already async); future: move to background job if latency becomes UX issue.
- **Large image buffers in memory**: 10 MB cap on upload; agent-generated images are 1–4 MB from OpenAI. No streaming needed at this scale.
- **Vision model compatibility**: `buildAgentMessages` with `image_url` blocks requires a vision-capable model. Claude Opus/Sonnet support this. Agents using non-vision models should not pass `imageResolver` — graceful degradation is built in.

## Open Follow-ups (post-merge)

- Shopify-ops: allow boss to select which generated image(s) to attach (currently all go to Shopify)
- Image library endpoint (`GET /v1/images`) for future media browser UI
- Async image generation (pending → webhook → ready) for slower models
- `images.remove_background` tool wrapping CF's transform API
