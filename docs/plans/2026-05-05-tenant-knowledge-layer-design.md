# Tenant Knowledge Layer — Design

**Date:** 2026-05-05
**Status:** Approved, ready for implementation plan

## Problem

Workflows currently run with no tenant memory. Each agent invocation is blind to:

- Brand voice / writing tone / banned phrases
- Company values, positioning, target audience
- Product policies (e.g. "no medical claims", "no competitor comparisons")
- Visual style (for image-generation agents)
- Tenant timezone (scheduling phrases like "next Monday" resolve against UTC today)

Today's two half-implementations:

1. `tenants.brand_voice` JSONB column — defined in `src/db/schema/tenants.ts:12`, **read by zero call sites**.
2. Per-agent duplication — `shopify-blog-writer.configSchema` carries `brandTone`, `bannedPhrases`, `preferredKeywords`, `targetLanguages`. Every new writer-style agent would have to repeat them.

Skill packs exist as a code-side primitive (`src/agents/lib/packs.ts`, `src/agents/builtin/<agent>/packs/*.md`) but are bundled at build time. Tenants cannot install their own.

## Goals

- One tenant-shared knowledge surface every agent automatically inherits.
- A pluggable **user-installable** skill-pack mechanism so tenants can add custom methodologies, brand guides, or compliance rules without a code change.
- Single source of truth — eliminate the per-agent duplication of brand-voice fields.
- No new infra. Postgres only. No RAG / pgvector in this iteration.

## Non-goals

- pgvector / vector search for product catalogs or historical articles. Those are addressed by exposing **tools** (e.g. `shopify.list_products`, `shopify.list_articles`) on the relevant agents, where the data's authoritative source already lives. Out of scope here.
- Per-tenant model overrides. The "OpenRouter only, model decided in code" rule continues.
- Encryption at rest of profile / pack content. Same level of protection as `agent_configs.config` today.
- Versioning of user packs. `updated_at` is the only history; no diff/rollback UI.

## Architecture

One primitive — **markdown documents** — used in two layers.

```
┌────────────────────────────────────────────────────────┐
│  Tenant layer                                          │
│                                                        │
│  ① Tenant Profile (markdown blob, always-injected)     │
│      tenants.profile_md TEXT                           │
│      tenants.timezone   TEXT  (only structured field)  │
│                                                        │
│  ② Skill Packs (markdown packs, scoped to agents)      │
│      tenant_skill_packs table                          │
│      applies_to: agentId[]  (= scope AND activation)   │
│                                                        │
└────────────────────────────────────────────────────────┘
                       ↓ injected by
┌────────────────────────────────────────────────────────┐
│  Orchestrator                                          │
│                                                        │
│  buildRuntimeContext(tenantId)  →  Promise<string>     │
│    ┌─ "Current time: <ISO>"                            │
│    ├─ "Tenant timezone: <IANA>"                        │
│    └─ "## Tenant profile\n\n<profile_md>"              │
│                                                        │
│  loadPacks({ tenantId, agentId, builtInDir, … })       │
│    ┌─ built-in packs from fs (toggled by config)       │
│    └─ tenant_skill_packs WHERE agentId = ANY(applies_to)│
│                                                        │
└────────────────────────────────────────────────────────┘
                       ↓
       Each agent's full system prompt:

       [runtime context: profile + timezone + now]
       [built-in packs]
       [tenant skill packs]
       ---
       [agent default prompt]
       ---
       [user message / brief]
```

Layer 3 — large unstructured data (catalogs, historical articles) — is **out of scope**; the design choice is to expose those via tools on the agents that need them, not to ingest them into a knowledge index.

## Data model

### Migration `0007_tenant_knowledge_layer.sql`

```sql
ALTER TABLE tenants
  ADD COLUMN profile_md TEXT NOT NULL DEFAULT '',
  ADD COLUMN timezone   TEXT NOT NULL DEFAULT 'UTC';

-- Carry brand_voice forward into profile_md so existing tenants don't lose
-- their (unused-but-recorded) brand preferences.
UPDATE tenants
SET profile_md =
  COALESCE(profile_md, '') ||
  CASE WHEN brand_voice IS NOT NULL THEN
    '## Brand voice (migrated)' || E'\n\n' ||
    'Tone: ' || COALESCE(brand_voice->>'tone', '(unspecified)') || E'\n' ||
    'Languages: ' || COALESCE(brand_voice->'languages'::text, '[]') || E'\n' ||
    'Preferred keywords: ' || COALESCE(brand_voice->'keywords'::text, '[]') || E'\n' ||
    'Forbidden phrases: ' || COALESCE(brand_voice->'forbidden'::text, '[]') || E'\n'
  ELSE '' END
WHERE brand_voice IS NOT NULL;

ALTER TABLE tenants DROP COLUMN brand_voice;

CREATE TABLE tenant_skill_packs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  applies_to  TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT  tenant_skill_packs_tenant_key_uq UNIQUE (tenant_id, key)
);

CREATE INDEX tenant_skill_packs_tenant_idx
  ON tenant_skill_packs (tenant_id);
CREATE INDEX tenant_skill_packs_applies_to_gin
  ON tenant_skill_packs USING GIN (applies_to);
```

### Drizzle schema

`src/db/schema/tenants.ts`:

```ts
export const tenants = pgTable('tenants', {
  id:        uuid('id').primaryKey().defaultRandom(),
  name:      text('name').notNull(),
  slug:      text('slug').notNull().unique(),
  plan:      text('plan', { enum: subscriptionPlanEnum }).notNull().default('basic'),
  profileMd: text('profile_md').notNull().default(''),
  timezone:  text('timezone').notNull().default('UTC'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});
```

New file `src/db/schema/tenant_skill_packs.ts`:

```ts
export const tenantSkillPacks = pgTable('tenant_skill_packs', {
  id:         uuid('id').primaryKey().defaultRandom(),
  tenantId:   uuid('tenant_id').notNull()
                .references(() => tenants.id, { onDelete: 'cascade' }),
  key:        text('key').notNull(),
  name:       text('name').notNull(),
  body:       text('body').notNull(),
  appliesTo:  text('applies_to').array().notNull().default([]),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantKeyUnique: uniqueIndex('tenant_skill_packs_tenant_key_uq').on(t.tenantId, t.key),
  tenantIdx:       index('tenant_skill_packs_tenant_idx').on(t.tenantId),
}));
```

Re-exported from `src/db/schema/index.ts`.

### Agent config

`agent_configs.config.skills` (jsonb) loosens from each agent's hard-coded
`z.object({ seoFundamentals: bool, eeat: bool, ... })` to a shared
`skillsToggleSchema = z.record(z.string(), z.boolean()).default({})`. The
DB column does not change; only the parse schema does.

`skills` continues to govern **built-in pack** on/off. User packs are
governed entirely by `tenant_skill_packs.applies_to` — no separate toggle.

## Runtime injection

### `src/orchestrator/runtime-context.ts`

```ts
export async function buildRuntimeContext(tenantId: string): Promise<string> {
  const [tenant] = await db.select({
    profileMd: tenants.profileMd,
    timezone:  tenants.timezone,
  }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);

  const now     = new Date().toISOString();
  const tz      = tenant?.timezone ?? 'UTC';
  const profile = tenant?.profileMd?.trim();

  let block = `Runtime context:\n- Current time: ${now}\n- Tenant timezone: ${tz}\n`;
  if (profile) {
    block += `\n## Tenant profile\n\n${profile}\n`;
  }
  return `${block}\n---\n\n`;
}
```

Caller in `src/orchestrator/graph.ts:76` switches to
`await buildRuntimeContext(opts.tenantId)`. The graph builder is already
async, so no signature ripple.

### `src/agents/lib/packs.ts`

```ts
export interface PackSource {
  builtInDir:     string;
  builtInEnabled: Record<string, boolean>;
  tenantId:       string;
  agentId:        string;
}

export async function loadPacks(src: PackSource): Promise<string> {
  // 1. Read built-in .md files from src.builtInDir (existing logic)
  // 2. Filter by src.builtInEnabled[parsed.key] === true
  // 3. SELECT * FROM tenant_skill_packs
  //    WHERE tenant_id = src.tenantId AND src.agentId = ANY(applies_to)
  //    ORDER BY name ASC
  // 4. Concatenate: built-in first (defaults), tenant after (overrides)
  // 5. Return joined markdown
}
```

Built-in pack on-disk format unchanged (frontmatter `key/name/version`).
Tenant packs in the DB carry their metadata in sibling columns — no
frontmatter required in `body`.

Call sites (e.g. `src/agents/builtin/shopify-blog-writer/index.ts:289`)
update only the args:

```ts
const packsBlock = await loadPacks({
  builtInDir:     packsDir,
  builtInEnabled: cfg.skills,
  tenantId:       ctx.tenantId,
  agentId:        'shopify-blog-writer',
});
```

### Final system prompt order

```
[buildRuntimeContext output]   ← profile + timezone + now
[built-in packs]               ← seo-fundamentals, eeat, etc.
[tenant skill packs]           ← user-uploaded
---
[agent default prompt]
---
[user message / brief]
```

Tenant profile is first because it influences everything downstream;
packs sit before the agent prompt as a methodology base; the agent's
own prompt remains the last specific instruction layer.

## API surface

All routes go through `requireAuth` + `requireTenant` and declare Zod
schemas (querystring/body/response) so Swagger stays accurate. Files
land in `src/api/`.

### Tenant Profile

```
GET  /tenants/:id/profile      → { profileMd: string, timezone: string }
PUT  /tenants/:id/profile      ← { profileMd?: string, timezone?: string }
                               → 200 { profileMd, timezone }
```

Validation:

- `profileMd` ≤ 32 KB. Hard cap so a tenant can't blow the per-prompt
  token budget on every agent run.
- `timezone` checked against `Intl.supportedValuesOf('timeZone')`;
  invalid → 400.

### Skill Packs

```
GET    /tenants/:id/skill-packs           → [{ id, key, name, body, appliesTo, ... }]
POST   /tenants/:id/skill-packs           ← { key, name, body, appliesTo: string[] }
                                          → 201
GET    /tenants/:id/skill-packs/:packId   → { id, ... }
PUT    /tenants/:id/skill-packs/:packId   ← { name?, body?, appliesTo? }
                                          → 200
DELETE /tenants/:id/skill-packs/:packId   → 204
```

Validation:

- `key` regex `^tenant\.[a-z0-9-]{1,60}$`. The `tenant.` prefix
  prevents collision with built-in keys (`eeat`, `seoFundamentals`,
  `aiSeo`, `geo`).
- `body` ≤ 64 KB.
- Every entry in `appliesTo` must satisfy `agentRegistry.has(id)`;
  otherwise 400 with the unknown ids.
- `(tenant_id, key)` unique violation → 409 Conflict.

## Breaking changes

Per CLAUDE.md "No backward-compat shims", these land in one commit
(plus the data-cleanup script run once after deploy).

### Code

1. `src/agents/builtin/shopify-blog-writer/index.ts` `configSchema`:
   remove `brandTone`, `bannedPhrases`, `preferredKeywords`,
   `targetLanguages`. The agent's `constraints[]` builder no longer
   reads these — tenant profile carries them.
2. Same file, `skills` field: replace
   `z.object({ seoFundamentals, eeat, aiSeo, geo })` with the shared
   `skillsToggleSchema`. Same change in any other agent that hard-coded
   a skills object (`seo-strategist`, `product-planner`,
   `product-designer`, `market-researcher`).
3. `src/orchestrator/runtime-context.ts`: signature becomes
   `(tenantId: string) => Promise<string>`. Single caller in `graph.ts`.
4. `src/db/schema/tenants.ts`: remove `brandVoice` field; add
   `profileMd` and `timezone`.
5. `src/agents/lib/packs.ts`: signature becomes the `PackSource`
   object form above.

### Data

- Migration 0007 carries `brand_voice` content forward into `profile_md`
  before dropping the column. Tenants who never filled `brand_voice`
  see no change.
- `agent_configs.config` rows containing the deprecated keys
  (`brandTone`, `bannedPhrases`, `preferredKeywords`, `targetLanguages`)
  become dead jsonb entries (the new parse schema ignores them silently
  via Zod's default behavior). One-shot cleanup script
  `scripts/cleanup-deprecated-config-fields.ts` removes them after deploy.

### Docs

- `docs/API_GUIDE.md`: add **Tenant Profile** and **Skill Packs**
  sections; remove the writer-activation paragraphs that mention
  `brandTone` etc.
- `requirements.md`: nothing — the spec already implies "tenant
  context"; no claim is invalidated.

## Testing strategy

Existing tiered convention (unit no DB; integration on local Supabase
with stubbed external `fetch`).

### Unit (`tests/`)

- `runtime-context.test.ts`
  - empty profile + default timezone → only the time/tz block
  - filled profile + custom timezone → full block, correct order
  - tenant row missing → falls back to UTC + empty profile (defense in
    depth; `requireTenant` already gates this in production)
- `packs.test.ts`
  - only built-ins → identical to current behavior
  - only tenant pack matching `applies_to` → loaded
  - both → built-ins first, tenant second
  - tenant pack with `applies_to` excluding the calling agent → not loaded
- `tenant-profile-validation.test.ts`
  - 32 KB cap rejects oversize body
  - timezone whitelist rejects "Asia/Atlantis"
  - schema round-trips empty / full payloads

### Integration (`tests/integration/`)

- `tenant-profile.integration.test.ts`
  - PUT then GET round-trips
  - run a task with FakeChatModel; the captured system prompt contains
    the profile content
- `skill-packs.integration.test.ts`
  - full CRUD
  - `applies_to: ['shopify-blog-writer']` → blog-writer's prompt contains
    the pack body; another agent's does not
  - delete then re-run → pack absent
  - duplicate `(tenant, key)` POST → 409
  - `appliesTo` containing an unknown agent id → 400

### Existing tests

Mostly unaffected — they assert on structured agent output, not on the
prompt text. Where fixtures inject `brandTone` etc., those keys are
removed; behavior is identical because the new schema ignores them.

## Deploy order

1. Run migration `0007_tenant_knowledge_layer.sql` (drop `brand_voice`,
   add `profile_md` / `timezone`, create `tenant_skill_packs`).
2. Deploy code (runtime-context async, packs union, agent
   configSchemas trimmed, new API routes).
3. Run `scripts/cleanup-deprecated-config-fields.ts` once to clear dead
   jsonb keys from `agent_configs.config`.

## Open questions / future work

- **Pack templates / marketplace.** A library of curated packs ("Beauty
  brand voice starter", "B2B SaaS positioning") that tenants can clone
  as a starting point. Out of scope.
- **Pack versioning UI.** Deferred. `updated_at` is the only audit
  signal; no diff/rollback yet.
- **Quotas.** Per-tenant pack count cap once subscription enforcement
  lands. Currently nothing limits creation beyond the per-pack 64 KB.
- **`list_products` / `list_articles` tools.** The Layer-3 read tools
  for catalog / historical-article context. Separate ticket; this
  design's tool-based-retrieval approach assumes those land
  incrementally as agents need them.
