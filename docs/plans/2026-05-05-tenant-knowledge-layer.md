# Tenant Knowledge Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a tenant-shared knowledge layer (markdown profile + user-installable skill packs) so every agent automatically inherits brand voice, policies, and methodology, eliminating per-agent duplication.

**Architecture:** Two-layer markdown primitive. Layer 1 = `tenants.profile_md` (single TEXT, always-injected) + `tenants.timezone` (only structured field). Layer 2 = `tenant_skill_packs` table (markdown body + `applies_to: agentId[]` which doubles as scope and activation). The orchestrator's `runtime-context.ts` becomes async and prepends the profile to every system prompt; `loadPacks()` unions built-in fs packs with DB tenant packs scoped to the calling agent. Hard cuts no shims: drop the orphan `tenants.brand_voice` column and the duplicated `brandTone / bannedPhrases / preferredKeywords / targetLanguages` fields from the writer agent.

**Tech Stack:** Fastify 5, Drizzle ORM, Postgres, Zod (with `fastify-type-provider-zod`), Vitest, LangGraph.js, OpenRouter via LangChain.

**Reference design:** [`docs/plans/2026-05-05-tenant-knowledge-layer-design.md`](./2026-05-05-tenant-knowledge-layer-design.md)

**Conventions to follow** (from CLAUDE.md):

- Run `pnpm typecheck && pnpm lint:fix` before every commit.
- API routes MUST declare `schema` (tags + body/query + response) so Swagger picks them up.
- Drizzle returns `Date` objects — use `z.preprocess(..., .toISOString())` on response timestamps (see `src/api/schemas.ts`).
- Tests are tiered: unit (no DB, mock LLM/fetch) vs integration (local Supabase, stub external `fetch`). No test should hit OpenRouter.
- Idempotent boundaries — handwritten migrations re-run on every `pnpm db:migrate`, so use `IF NOT EXISTS` guards.
- `docs/API_GUIDE.md` MUST be updated for any new endpoint.
- "No backward-compat shims" — when refactoring agent fields, rename across the codebase in one commit.

---

## Task 1: Handwritten migration — schema + data carry-forward

**Files:**

- Create: `drizzle/0007_tenant_knowledge_layer.sql`

**Step 1: Create the migration file**

Single idempotent SQL file. Drizzle's auto-generated migrations don't run before handwritten ones, so we put everything (column adds, data carry-forward, column drop, new table, indexes) in one transaction-wrapped handwritten file.

```sql
-- Layer 1: tenant profile fields. Idempotent — re-runnable on every db:migrate.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS profile_md TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone   TEXT NOT NULL DEFAULT 'UTC';

-- Carry forward orphan brand_voice content (if column still exists from before
-- this migration ran). Guarded so subsequent runs are no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'brand_voice'
  ) THEN
    EXECUTE $u$
      UPDATE tenants
      SET profile_md =
        '## Brand voice (migrated)' || E'\n\n' ||
        'Tone: ' || COALESCE(brand_voice->>'tone', '(unspecified)') || E'\n' ||
        'Languages: ' || COALESCE((brand_voice->'languages')::text, '[]') || E'\n' ||
        'Preferred keywords: ' || COALESCE((brand_voice->'keywords')::text, '[]') || E'\n' ||
        'Forbidden phrases: ' || COALESCE((brand_voice->'forbidden')::text, '[]') || E'\n'
      WHERE brand_voice IS NOT NULL AND profile_md = ''
    $u$;
    EXECUTE 'ALTER TABLE tenants DROP COLUMN brand_voice';
  END IF;
END $$;

-- Layer 2: skill packs.
CREATE TABLE IF NOT EXISTS tenant_skill_packs (
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
CREATE INDEX IF NOT EXISTS tenant_skill_packs_tenant_idx
  ON tenant_skill_packs (tenant_id);
CREATE INDEX IF NOT EXISTS tenant_skill_packs_applies_to_gin
  ON tenant_skill_packs USING GIN (applies_to);
```

**Step 2: Run migration locally**

```bash
pnpm db:migrate
```

Expected: clean log "Drizzle migrations complete." then "Applying handwritten SQL migrations…" then no error. Re-run a second time — must also succeed (idempotency check).

**Step 3: Verify in psql / Studio**

```bash
psql "$DATABASE_URL" -c '\d tenants' -c '\d tenant_skill_packs'
```

Expected: `tenants` shows `profile_md text NOT NULL DEFAULT ''::text`, `timezone text NOT NULL DEFAULT 'UTC'::text`, and **no** `brand_voice` column. `tenant_skill_packs` shows the columns + uq + GIN index.

**Step 4: Commit**

```bash
git add drizzle/0007_tenant_knowledge_layer.sql
git commit -m "db(migrate): tenant knowledge layer — profile_md/timezone on tenants + tenant_skill_packs"
```

---

## Task 2: Drizzle schema — update tenants + add tenant_skill_packs

**Files:**

- Modify: `src/db/schema/tenants.ts`
- Create: `src/db/schema/tenant_skill_packs.ts`
- Modify: `src/db/schema/index.ts`

**Step 1: Edit `src/db/schema/tenants.ts`**

Replace the `brandVoice` jsonb field with `profileMd` + `timezone`:

```ts
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const subscriptionPlanEnum = ['basic', 'pro', 'flagship'] as const;
export type SubscriptionPlan = (typeof subscriptionPlanEnum)[number];

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

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
```

(The `jsonb` import is no longer needed — remove it from the imports line.)

**Step 2: Create `src/db/schema/tenant_skill_packs.ts`**

```ts
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Per-tenant markdown skill pack. Body is plain markdown (no frontmatter —
 * metadata lives in sibling columns). `applies_to` doubles as scope AND
 * activation: a pack with applies_to = ['shopify-blog-writer'] is loaded
 * for that agent's prompt automatically; remove the agent id to disable.
 *
 * `key` must be `tenant.<slug>` to keep the namespace disjoint from
 * built-in pack keys (`eeat`, `seoFundamentals`, `aiSeo`, …).
 */
export const tenantSkillPacks = pgTable(
  'tenant_skill_packs',
  {
    id:        uuid('id').primaryKey().defaultRandom(),
    tenantId:  uuid('tenant_id')
                 .notNull()
                 .references(() => tenants.id, { onDelete: 'cascade' }),
    key:       text('key').notNull(),
    name:      text('name').notNull(),
    body:      text('body').notNull(),
    appliesTo: text('applies_to').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantKeyUnique: uniqueIndex('tenant_skill_packs_tenant_key_uq').on(t.tenantId, t.key),
    tenantIdx:       index('tenant_skill_packs_tenant_idx').on(t.tenantId),
  }),
);

export type TenantSkillPack = typeof tenantSkillPacks.$inferSelect;
export type NewTenantSkillPack = typeof tenantSkillPacks.$inferInsert;
```

**Step 3: Re-export from `src/db/schema/index.ts`**

Add `export * from './tenant_skill_packs.js';` to the existing list. Keep ordering so `tenants` exports come before `tenant_skill_packs` (it depends on the FK target).

**Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If anywhere references `tenants.brandVoice`, the compiler will flag it — there should be zero such call sites (we already verified during recon), but trust the compiler.

**Step 5: Commit**

```bash
git add src/db/schema/tenants.ts src/db/schema/tenant_skill_packs.ts src/db/schema/index.ts
git commit -m "db(schema): tenants.profile_md/timezone + tenant_skill_packs"
```

---

## Task 3: Skill pack repository

**Files:**

- Create: `src/agents/skill-packs-repository.ts`
- Test: `tests/integration/skill-packs-repository.test.ts`

**Step 1: Write the failing integration test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { tenantSkillPacks, tenants } from '../../src/db/schema/index.js';
import {
  createPack,
  deletePack,
  listPacksForAgent,
  listTenantPacks,
  updatePack,
} from '../../src/agents/skill-packs-repository.js';

describe('skill-packs-repository', () => {
  let tenantId: string;

  beforeEach(async () => {
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Test', slug: `t-${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  afterEach(async () => {
    await db.delete(tenantSkillPacks).where(/* by tenantId */);
    await db.delete(tenants).where(/* by id */);
  });

  it('creates a pack scoped to applies_to', async () => {
    const pack = await createPack(tenantId, {
      key: 'tenant.brand-guide',
      name: 'Brand Guide',
      body: '# Voice\n\nWarm.',
      appliesTo: ['shopify-blog-writer'],
    });
    expect(pack.id).toBeDefined();
    expect(pack.appliesTo).toEqual(['shopify-blog-writer']);
  });

  it('listPacksForAgent returns only packs with that agent in applies_to', async () => {
    await createPack(tenantId, {
      key: 'tenant.a',
      name: 'A',
      body: 'a',
      appliesTo: ['shopify-blog-writer'],
    });
    await createPack(tenantId, {
      key: 'tenant.b',
      name: 'B',
      body: 'b',
      appliesTo: ['seo-strategist'],
    });
    const writerPacks = await listPacksForAgent(tenantId, 'shopify-blog-writer');
    expect(writerPacks.map((p) => p.key)).toEqual(['tenant.a']);
  });

  it('updatePack patches partial fields', async () => {
    const pack = await createPack(tenantId, {
      key: 'tenant.k',
      name: 'K',
      body: 'old',
      appliesTo: [],
    });
    const updated = await updatePack(tenantId, pack.id, { body: 'new' });
    expect(updated.body).toBe('new');
    expect(updated.name).toBe('K');
  });

  it('deletePack removes the row, scoped to tenant', async () => {
    const pack = await createPack(tenantId, {
      key: 'tenant.k',
      name: 'K',
      body: 'b',
      appliesTo: [],
    });
    await deletePack(tenantId, pack.id);
    const remaining = await listTenantPacks(tenantId);
    expect(remaining).toEqual([]);
  });

  it('rejects duplicate (tenant, key) at the DB level', async () => {
    await createPack(tenantId, { key: 'tenant.dup', name: 'A', body: 'a', appliesTo: [] });
    await expect(
      createPack(tenantId, { key: 'tenant.dup', name: 'B', body: 'b', appliesTo: [] }),
    ).rejects.toThrow();
  });
});
```

(The `where(/* by … */)` placeholders use `eq()` from `drizzle-orm` — fill in when typing for real.)

**Step 2: Run test to verify it fails**

```bash
pnpm test:integration -- tests/integration/skill-packs-repository.test.ts
```

Expected: FAIL — module `../../src/agents/skill-packs-repository.js` not found.

**Step 3: Implement the repository**

```ts
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantSkillPacks, type TenantSkillPack } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';

export interface CreatePackInput {
  key: string;
  name: string;
  body: string;
  appliesTo: string[];
}

export interface UpdatePackInput {
  name?: string;
  body?: string;
  appliesTo?: string[];
}

export async function createPack(
  tenantId: string,
  input: CreatePackInput,
): Promise<TenantSkillPack> {
  const [row] = await db
    .insert(tenantSkillPacks)
    .values({ tenantId, ...input })
    .returning();
  if (!row) throw new Error('skill pack insert returned no row');
  return row;
}

export async function listTenantPacks(tenantId: string): Promise<TenantSkillPack[]> {
  return db
    .select()
    .from(tenantSkillPacks)
    .where(eq(tenantSkillPacks.tenantId, tenantId))
    .orderBy(tenantSkillPacks.name);
}

export async function listPacksForAgent(
  tenantId: string,
  agentId: string,
): Promise<TenantSkillPack[]> {
  // GIN-friendly array containment: applies_to @> ARRAY[agentId]
  return db
    .select()
    .from(tenantSkillPacks)
    .where(
      and(
        eq(tenantSkillPacks.tenantId, tenantId),
        sql`${tenantSkillPacks.appliesTo} @> ARRAY[${agentId}]::text[]`,
      ),
    )
    .orderBy(tenantSkillPacks.name);
}

export async function getPack(
  tenantId: string,
  packId: string,
): Promise<TenantSkillPack> {
  const [row] = await db
    .select()
    .from(tenantSkillPacks)
    .where(and(eq(tenantSkillPacks.tenantId, tenantId), eq(tenantSkillPacks.id, packId)))
    .limit(1);
  if (!row) throw new NotFoundError(`Skill pack ${packId}`);
  return row;
}

export async function updatePack(
  tenantId: string,
  packId: string,
  input: UpdatePackInput,
): Promise<TenantSkillPack> {
  const [row] = await db
    .update(tenantSkillPacks)
    .set({ ...input, updatedAt: sql`now()` })
    .where(and(eq(tenantSkillPacks.tenantId, tenantId), eq(tenantSkillPacks.id, packId)))
    .returning();
  if (!row) throw new NotFoundError(`Skill pack ${packId}`);
  return row;
}

export async function deletePack(tenantId: string, packId: string): Promise<void> {
  const result = await db
    .delete(tenantSkillPacks)
    .where(and(eq(tenantSkillPacks.tenantId, tenantId), eq(tenantSkillPacks.id, packId)));
  if (result.rowCount === 0) throw new NotFoundError(`Skill pack ${packId}`);
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test:integration -- tests/integration/skill-packs-repository.test.ts
```

Expected: PASS (5 tests).

**Step 5: Lint + commit**

```bash
pnpm lint:fix
git add src/agents/skill-packs-repository.ts tests/integration/skill-packs-repository.test.ts
git commit -m "feat(agents): tenant_skill_packs repository — CRUD scoped by tenant"
```

---

## Task 4: Tenant profile repository

**Files:**

- Create: `src/tenants/profile-repository.ts`
- Test: `tests/integration/tenant-profile-repository.test.ts`

**Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { tenants } from '../../src/db/schema/index.js';
import {
  getTenantProfile,
  updateTenantProfile,
} from '../../src/tenants/profile-repository.js';

describe('tenant-profile-repository', () => {
  let tenantId: string;

  beforeEach(async () => {
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Test', slug: `t-${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('returns defaults for a fresh tenant', async () => {
    const profile = await getTenantProfile(tenantId);
    expect(profile).toEqual({ profileMd: '', timezone: 'UTC' });
  });

  it('updates profileMd and timezone', async () => {
    const updated = await updateTenantProfile(tenantId, {
      profileMd: '# Voice\n\nWarm.',
      timezone: 'Asia/Taipei',
    });
    expect(updated.profileMd).toContain('Warm');
    expect(updated.timezone).toBe('Asia/Taipei');

    // Round-trip
    const fetched = await getTenantProfile(tenantId);
    expect(fetched).toEqual(updated);
  });

  it('partial update preserves untouched fields', async () => {
    await updateTenantProfile(tenantId, { profileMd: 'first' });
    const after = await updateTenantProfile(tenantId, { timezone: 'Asia/Tokyo' });
    expect(after.profileMd).toBe('first');
    expect(after.timezone).toBe('Asia/Tokyo');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test:integration -- tests/integration/tenant-profile-repository.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement**

```ts
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenants } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';

export interface TenantProfile {
  profileMd: string;
  timezone: string;
}

export interface UpdateTenantProfileInput {
  profileMd?: string;
  timezone?: string;
}

export async function getTenantProfile(tenantId: string): Promise<TenantProfile> {
  const [row] = await db
    .select({ profileMd: tenants.profileMd, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new NotFoundError(`Tenant ${tenantId}`);
  return row;
}

export async function updateTenantProfile(
  tenantId: string,
  input: UpdateTenantProfileInput,
): Promise<TenantProfile> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.profileMd !== undefined) set.profileMd = input.profileMd;
  if (input.timezone !== undefined) set.timezone = input.timezone;

  const [row] = await db
    .update(tenants)
    .set(set)
    .where(eq(tenants.id, tenantId))
    .returning({ profileMd: tenants.profileMd, timezone: tenants.timezone });
  if (!row) throw new NotFoundError(`Tenant ${tenantId}`);
  return row;
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test:integration -- tests/integration/tenant-profile-repository.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
pnpm lint:fix
git add src/tenants/profile-repository.ts tests/integration/tenant-profile-repository.test.ts
git commit -m "feat(tenants): profile repository — get/update profile_md + timezone"
```

---

## Task 5: Make `buildRuntimeContext` async + tenant-aware

**Files:**

- Modify: `src/orchestrator/runtime-context.ts`
- Modify: `tests/runtime-context.test.ts`

**Step 1: Update the unit test first**

Replace the existing test with one that mocks the `tenants` query and checks the new behavior. Use `vi.mock` to stub `db.select` chain (or factor a tiny seam — see below).

The cleanest approach is to inject the loader as a parameter — but that ripples to all call sites. Easier: keep the function reading `db` directly, and have the test seed the local Supabase. Since `runtime-context.test.ts` is a UNIT test today, we need DB access — either:

(a) Move the test to `tests/integration/runtime-context.integration.test.ts` (keeps unit suite no-DB).
(b) Refactor `buildRuntimeContext(tenantId, deps?)` to accept an optional `loadProfile` for unit tests.

Pick (a). Move the file and rewrite:

```ts
// tests/integration/runtime-context.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { tenants } from '../../src/db/schema/index.js';
import { buildRuntimeContext } from '../../src/orchestrator/runtime-context.js';

describe('buildRuntimeContext (integration)', () => {
  let tenantId: string;

  beforeAll(async () => {
    const [t] = await db
      .insert(tenants)
      .values({
        name: 'Tester',
        slug: `rt-${Date.now()}`,
        profileMd: '## Voice\n\nWarm and direct.',
        timezone: 'Asia/Taipei',
      })
      .returning();
    tenantId = t!.id;
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('emits Runtime context block with timezone, current time, and profile', async () => {
    const block = await buildRuntimeContext(tenantId);
    expect(block.startsWith('Runtime context:')).toBe(true);
    expect(block).toMatch(/- Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(block).toContain('- Tenant timezone: Asia/Taipei');
    expect(block).toContain('## Tenant profile');
    expect(block).toContain('Warm and direct.');
    expect(block.endsWith('---\n\n')).toBe(true);
  });

  it('omits the profile section when profile_md is empty', async () => {
    const [empty] = await db
      .insert(tenants)
      .values({ name: 'Empty', slug: `empty-${Date.now()}` })
      .returning();
    try {
      const block = await buildRuntimeContext(empty!.id);
      expect(block).not.toContain('## Tenant profile');
      expect(block).toContain('- Tenant timezone: UTC');
    } finally {
      await db.delete(tenants).where(eq(tenants.id, empty!.id));
    }
  });

  it('falls back to UTC + empty profile when tenant row is missing', async () => {
    const block = await buildRuntimeContext('00000000-0000-0000-0000-000000000000');
    expect(block).toContain('- Tenant timezone: UTC');
    expect(block).not.toContain('## Tenant profile');
  });
});
```

Delete the old `tests/runtime-context.test.ts` — its assertions no longer match.

**Step 2: Run to verify failure**

```bash
pnpm test:integration -- tests/integration/runtime-context.integration.test.ts
```

Expected: FAIL — `buildRuntimeContext` either still synchronous or still emitting old block.

**Step 3: Rewrite `src/orchestrator/runtime-context.ts`**

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenants } from '../db/schema/index.js';

/**
 * Per-task runtime context block prepended to every system prompt
 * (supervisor + each agent) by the orchestrator. Single insertion point
 * for tenant- or time-sensitive facts the LLM needs but the static prompt
 * template doesn't carry.
 *
 * The graph is rebuilt fresh for every worker pickup (runner.ts → buildGraph),
 * so resumed tasks always see "now", not the time when they first started,
 * and pick up tenant profile edits made between attempts.
 */
export async function buildRuntimeContext(tenantId: string): Promise<string> {
  const [row] = await db
    .select({ profileMd: tenants.profileMd, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const now = new Date().toISOString();
  const tz = row?.timezone ?? 'UTC';
  const profile = row?.profileMd?.trim();

  let block = `Runtime context:\n- Current time: ${now}\n- Tenant timezone: ${tz}\n`;
  if (profile) {
    block += `\n## Tenant profile\n\n${profile}\n`;
  }
  return `${block}\n---\n\n`;
}
```

**Step 4: Run to verify pass**

```bash
pnpm test:integration -- tests/integration/runtime-context.integration.test.ts
```

Expected: PASS.

**Step 5: Update both call sites**

`src/orchestrator/graph.ts:76` — change `buildRuntimeContext()` to `await buildRuntimeContext(opts.tenantId)`. The graph node function is already async.

`src/orchestrator/supervisor.ts:95` — `buildRuntimeContext()` is in `new SystemMessage(buildRuntimeContext() + SUPERVISOR_PROMPT)`. The function `runSupervisor` is async (verify with Read first), so change to `new SystemMessage((await buildRuntimeContext(state.tenantId)) + SUPERVISOR_PROMPT)`.

**Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS. If supervisor's signature isn't async or doesn't have `state.tenantId` accessible, adapt accordingly — `GraphState.tenantId` exists per `src/orchestrator/state.ts` (verify with Read).

**Step 7: Commit**

```bash
pnpm lint:fix
git add src/orchestrator/runtime-context.ts src/orchestrator/graph.ts src/orchestrator/supervisor.ts tests/integration/runtime-context.integration.test.ts
git rm tests/runtime-context.test.ts
git commit -m "feat(orchestrator): runtime-context async + tenant-aware (profile + timezone)"
```

---

## Task 6: Extend `loadPacks()` to union built-in fs + tenant DB

**Files:**

- Modify: `src/agents/lib/packs.ts`
- Modify: `tests/packs.test.ts` (rename signature; existing test stays unit, no DB)
- Test: `tests/integration/skill-packs-loader.integration.test.ts` (DB part)

**Step 1: Refactor the signature**

The existing unit test still has value (built-in fs + frontmatter parsing). We just need to extend the function signature without breaking the fs-only path. Use an object arg with optional tenant fields.

Update `src/agents/lib/packs.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { listPacksForAgent } from '../skill-packs-repository.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

interface ParsedPack {
  key: string;
  name: string;
  version: string | number;
  body: string;
}

async function readBuiltInPack(filePath: string): Promise<ParsedPack | null> {
  const raw = await readFile(filePath, 'utf8');
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const fmRaw = match[1] ?? '';
  const body = (match[2] ?? '').trim();
  const fm: Record<string, string> = {};
  for (const line of fmRaw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) fm[k] = v;
  }
  if (!fm.key || !fm.name || !fm.version) return null;
  return { key: fm.key, name: fm.name, version: fm.version, body };
}

export interface PackSource {
  /** Built-in agent dir (e.g. `<agentDir>/packs/`). */
  builtInDir: string;
  /** Built-in pack on/off, keyed by frontmatter `key`. */
  builtInEnabled: Record<string, boolean>;
  /**
   * Tenant + agent for DB-side packs. When omitted, only built-ins are loaded —
   * keeps the function callable from places without a tenant context (e.g.
   * activation form preview).
   */
  tenantId?: string;
  agentId?: string;
}

/**
 * Load and concatenate enabled packs.
 *
 * Order: built-in (alphabetical) → tenant DB (alphabetical by name).
 * Built-ins act as defaults; tenant-supplied packs sit after so they read
 * as "additional house style on top".
 */
export async function loadPacks(src: PackSource): Promise<string> {
  const sections: string[] = [];

  // 1. Built-in fs packs (existing logic).
  const files = (await readdir(src.builtInDir)).filter((f) => f.endsWith('.md')).sort();
  for (const file of files) {
    const parsed = await readBuiltInPack(path.join(src.builtInDir, file));
    if (!parsed) continue;
    if (!src.builtInEnabled[parsed.key]) continue;
    sections.push(`## Skill: ${parsed.name} (v${parsed.version})\n\n${parsed.body}`);
  }

  // 2. Tenant DB packs (new).
  if (src.tenantId && src.agentId) {
    const tenantPacks = await listPacksForAgent(src.tenantId, src.agentId);
    for (const p of tenantPacks) {
      sections.push(`## Skill: ${p.name}\n\n${p.body.trim()}`);
    }
  }

  return sections.join('\n\n');
}
```

**Step 2: Update the existing unit test**

Replace the two test cases in `tests/packs.test.ts` to use the new signature. The fs-only path stays a unit test (no DB).

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPacks } from '../src/agents/lib/packs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, 'fixtures/packs');

describe('loadPacks (built-in fs only)', () => {
  it('includes only enabled packs and renders them with versioned headings', async () => {
    const out = await loadPacks({
      builtInDir: dir,
      builtInEnabled: { seoFundamentals: true, eeat: true, disabled: false },
    });
    expect(out).toMatch(/## Skill: SEO Fundamentals \(v1\)/);
    expect(out).toMatch(/## Skill: EEAT Discipline \(v2\)/);
    expect(out).not.toMatch(/disabled/i);
  });

  it('returns empty string when nothing enabled', async () => {
    const out = await loadPacks({
      builtInDir: dir,
      builtInEnabled: { seoFundamentals: false, eeat: false },
    });
    expect(out).toBe('');
  });
});
```

**Step 3: Run unit test**

```bash
pnpm test -- tests/packs.test.ts
```

Expected: PASS.

**Step 4: Write the integration test for the DB path**

```ts
// tests/integration/skill-packs-loader.integration.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../../src/db/client.js';
import { tenantSkillPacks, tenants } from '../../src/db/schema/index.js';
import { loadPacks } from '../../src/agents/lib/packs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, '../fixtures/packs');

describe('loadPacks (with tenant DB packs)', () => {
  let tenantId: string;

  beforeEach(async () => {
    const [t] = await db
      .insert(tenants)
      .values({ name: 'T', slug: `lp-${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  afterEach(async () => {
    await db.delete(tenantSkillPacks).where(eq(tenantSkillPacks.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('includes tenant pack scoped to the calling agent', async () => {
    await db.insert(tenantSkillPacks).values({
      tenantId,
      key: 'tenant.brand-guide',
      name: 'Brand Guide',
      body: '## Voice\n\nWarm.',
      appliesTo: ['shopify-blog-writer'],
    });

    const out = await loadPacks({
      builtInDir: dir,
      builtInEnabled: { seoFundamentals: true },
      tenantId,
      agentId: 'shopify-blog-writer',
    });

    expect(out).toMatch(/## Skill: SEO Fundamentals/); // built-in first
    expect(out).toMatch(/## Skill: Brand Guide/);       // tenant after
    expect(out.indexOf('SEO Fundamentals'))
      .toBeLessThan(out.indexOf('Brand Guide'));
  });

  it('excludes tenant pack whose applies_to does not include the calling agent', async () => {
    await db.insert(tenantSkillPacks).values({
      tenantId,
      key: 'tenant.x',
      name: 'X',
      body: 'irrelevant',
      appliesTo: ['seo-strategist'],
    });
    const out = await loadPacks({
      builtInDir: dir,
      builtInEnabled: {},
      tenantId,
      agentId: 'shopify-blog-writer',
    });
    expect(out).toBe('');
  });
});
```

**Step 5: Run integration test**

```bash
pnpm test:integration -- tests/integration/skill-packs-loader.integration.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
pnpm typecheck && pnpm lint:fix
git add src/agents/lib/packs.ts tests/packs.test.ts tests/integration/skill-packs-loader.integration.test.ts
git commit -m "feat(agents): loadPacks unions built-in fs + tenant DB packs"
```

---

## Task 7: Update agent call sites of `loadPacks`

**Files:**

- Modify: `src/agents/builtin/shopify-blog-writer/index.ts:289-291`
- Modify: `src/agents/builtin/seo-strategist/index.ts` (around line 176)
- Modify: `src/agents/builtin/product-planner/index.ts` (around line 145)
- Modify: `src/agents/builtin/product-designer/index.ts` (around line 120)

**Step 1: Mechanical signature change at each call site**

Each file currently has:

```ts
const packsBlock = await loadPacks(packsDir, cfg.skills);
```

Replace with:

```ts
const packsBlock = await loadPacks({
  builtInDir:     packsDir,
  builtInEnabled: cfg.skills as Record<string, boolean>,
  tenantId:       ctx.tenantId,
  agentId:        '<agent-id>',  // hard-coded to manifest.id
});
```

Use the agent's literal id (`'shopify-blog-writer'`, `'seo-strategist'`, `'product-planner'`, `'product-designer'`).

**Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

**Step 3: Run full unit suite to ensure nothing regressed**

```bash
pnpm test
```

Expected: PASS. Existing agent unit tests don't hit DB so they go through the `tenantId` branch — but `listPacksForAgent` will be called with whatever `ctx.tenantId` the test fixture supplies. If the test uses a real-looking UUID without a DB, drizzle will throw. Two options:

(a) The agent unit tests already mock the LLM and don't actually invoke `loadPacks` with a real tenantId — they likely stub `build()`. Re-check by running.
(b) If they do call `loadPacks`, gate the DB call behind a try/catch in `loadPacks`: if `tenantId` lookup fails, treat as no tenant packs. **Don't do this** — silent failure hides bugs. Instead, add an opt-out: `tenantId: undefined` skips the DB call (already supported per Task 6 design).

Path: re-check the failing tests. If a unit test runs the full agent build, **fix the test** to either provide a DB-backed tenant or to skip the loadPacks invocation by mocking it.

**Step 4: Commit**

```bash
pnpm lint:fix
git add src/agents/builtin/{shopify-blog-writer,seo-strategist,product-planner,product-designer}/index.ts
git commit -m "feat(agents): wire loadPacks to tenant DB at every call site"
```

---

## Task 8: Loosen each agent's `skills` schema to `Record<string, boolean>`

**Files:**

- Create: `src/agents/lib/skills-schema.ts`
- Modify: `src/agents/builtin/shopify-blog-writer/index.ts:105-112`
- Modify: `src/agents/builtin/seo-strategist/index.ts` (skills block)
- Modify: `src/agents/builtin/product-planner/index.ts` (skills block)
- Modify: `src/agents/builtin/product-designer/index.ts` (skills block)

**Step 1: Add the shared schema**

```ts
// src/agents/lib/skills-schema.ts
import { z } from 'zod';

/**
 * Shared schema for the per-agent `skills` config field. Each key is a
 * built-in pack id (frontmatter `key`); value is on/off. Open record because
 * built-in pack keys are decided in code at each agent dir, not centrally.
 *
 * User-supplied tenant skill packs are NOT toggled here — their activation
 * lives in `tenant_skill_packs.applies_to`.
 */
export const skillsToggleSchema = z.record(z.string(), z.boolean()).default({});
export type SkillsToggle = z.infer<typeof skillsToggleSchema>;
```

**Step 2: Replace each agent's hard-coded `skills: z.object({...})`**

For each of the four agents, edit the `configSchema` so the `skills` field uses the shared schema. Drop the `as Record<string, boolean>` cast at the loadPacks call site (no longer needed because the schema already produces a `Record<string, boolean>`).

```ts
import { skillsToggleSchema } from '../../lib/skills-schema.js';

const configSchema = z.object({
  // ... existing fields
  skills: skillsToggleSchema,
});
```

For agents whose previous default was `seoFundamentals: true, eeat: true`, the user-facing default semantics change: an empty record means "nothing enabled". Decide per agent — for the writer, the previous defaults were sensible, so add a one-time DB seed via the same migration's tail (or just accept that newly activated tenants opt in explicitly via the activation form). **Skip the seed** — YAGNI; tenants who already activated have their existing config preserved.

**Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

**Step 4: Run unit tests**

```bash
pnpm test
```

Expected: PASS — agent tests assert on structured output, not skills schema shape.

**Step 5: Commit**

```bash
pnpm lint:fix
git add src/agents/lib/skills-schema.ts src/agents/builtin/{shopify-blog-writer,seo-strategist,product-planner,product-designer}/index.ts
git commit -m "feat(agents): unify skills schema → shared Record<string, boolean>"
```

---

## Task 9: Drop `brandTone / bannedPhrases / preferredKeywords / targetLanguages` from shopify-blog-writer

**Files:**

- Modify: `src/agents/builtin/shopify-blog-writer/index.ts` (configSchema lines 63-78, constraints builder lines 299-307)

**Step 1: Remove the four fields from `configSchema`**

In `configSchema`, delete the lines for `targetLanguages`, `brandTone`, `bannedPhrases`, `preferredKeywords`. Keep `publishToShopify`, `blogHandle`, `defaultAuthor`, `publishImmediately`, `credentialLabel`, `skills`, `generateCoverImage`, `coverImageStyle`.

**Step 2: Remove the constraint builder**

Inside `invoke = async (input)`, delete the lines that build `constraints[]` from those fields:

```ts
// DELETE:
const constraints: string[] = [];
if (cfg.brandTone) constraints.push(`Tone: ${cfg.brandTone}`);
if (cfg.preferredKeywords.length > 0) {
  constraints.push(`Preferred keywords: ${cfg.preferredKeywords.join(', ')}`);
}
if (cfg.bannedPhrases.length > 0) {
  constraints.push(`Avoid phrases: ${cfg.bannedPhrases.join(', ')}`);
}
constraints.push(`Writer fluent in: ${cfg.targetLanguages.join(', ')}`);
```

`buildAgentMessages(systemPrompt, input.messages, constraints, input.imageResolver)` is called twice (once for stage 1, once for the article). Both call sites need to drop `constraints` (or pass `[]`). Inspect `src/agents/lib/messages.ts` to see the signature — if `constraints` is required, decide:

- (a) Remove the parameter from `buildAgentMessages` (simpler; no other agents pass it meaningfully).
- (b) Keep the parameter; pass `[]`.

Pick (a) — agents that need ad-hoc constraints can build their own. Update `src/agents/lib/messages.ts` and any other caller.

**Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

**Step 4: Run unit tests**

```bash
pnpm test
```

Expected: PASS. The shopify-blog-writer unit test (and its EEAT integration variant) doesn't assert on these fields. Fix any fixture that injected `brandTone` etc. — they become unknown extra keys that Zod (with default behavior) drops silently, but explicit cleanup is clearer.

**Step 5: Commit**

```bash
pnpm lint:fix
git add src/agents/builtin/shopify-blog-writer/index.ts src/agents/lib/messages.ts
git commit -m "refactor(blog-writer): drop brandTone/bannedPhrases/preferredKeywords/targetLanguages — sourced from tenant profile now"
```

---

## Task 10: API — Tenant Profile route

**Files:**

- Create: `src/api/routes/profile.ts`
- Modify: `src/api/routes/index.ts`
- Test: `tests/integration/tenant-profile-api.integration.test.ts`

**Step 1: Write the failing integration test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildTestServer } from './helpers/server.js'; // existing helper, see lifecycle.test.ts
import { db } from '../../src/db/client.js';
import { tenantMembers, tenants } from '../../src/db/schema/index.js';

describe('PUT/GET /v1/tenants/:id/profile', () => {
  // Pattern follows tests/integration/lifecycle.test.ts — use the same auth fixtures.
  let app: Awaited<ReturnType<typeof buildTestServer>>;
  let tenantId: string;
  let authHeaders: Record<string, string>;

  beforeEach(async () => {
    ({ app, tenantId, authHeaders } = await setupTenantWithMember()); // helper to add
  });

  afterEach(async () => {
    await db.delete(tenantMembers).where(eq(tenantMembers.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
  });

  it('GET returns defaults for fresh tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/profile`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profileMd: '', timezone: 'UTC' });
  });

  it('PUT updates and round-trips', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/profile`,
      headers: authHeaders,
      payload: { profileMd: '# Voice\n\nWarm.', timezone: 'Asia/Taipei' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ profileMd: '# Voice\n\nWarm.', timezone: 'Asia/Taipei' });
  });

  it('rejects oversize profileMd (32KB cap)', async () => {
    const huge = 'x'.repeat(32 * 1024 + 1);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/profile`,
      headers: authHeaders,
      payload: { profileMd: huge },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid timezone', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/profile`,
      headers: authHeaders,
      payload: { timezone: 'Asia/Atlantis' },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

(The `setupTenantWithMember` helper is already a pattern in the integration suite — copy from `tests/integration/lifecycle.test.ts` if no shared helper exists.)

**Step 2: Run test to verify failure**

```bash
pnpm test:integration -- tests/integration/tenant-profile-api.integration.test.ts
```

Expected: FAIL — 404 because route is unregistered.

**Step 3: Implement the route**

```ts
// src/api/routes/profile.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getTenantProfile,
  updateTenantProfile,
} from '../../tenants/profile-repository.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';

const PROFILE_MD_MAX = 32 * 1024;
const validTimezones = new Set(Intl.supportedValuesOf('timeZone'));

const TenantIdParam = z.object({ id: z.string().uuid() });

const ProfileResponse = z.object({
  profileMd: z.string(),
  timezone: z.string(),
});

const UpdateProfileBody = z.object({
  profileMd: z.string().max(PROFILE_MD_MAX).optional(),
  timezone: z
    .string()
    .refine((tz) => validTimezones.has(tz), 'invalid IANA timezone')
    .optional(),
});

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/tenants/:id/profile',
    {
      schema: {
        tags: ['tenants'],
        params: TenantIdParam,
        response: { 200: ProfileResponse },
      },
    },
    async (req) => {
      const { id } = req.params as z.infer<typeof TenantIdParam>;
      return getTenantProfile(id);
    },
  );

  app.put(
    '/tenants/:id/profile',
    {
      schema: {
        tags: ['tenants'],
        params: TenantIdParam,
        body: UpdateProfileBody,
        response: { 200: ProfileResponse },
      },
    },
    async (req) => {
      const { id } = req.params as z.infer<typeof TenantIdParam>;
      const body = req.body as z.infer<typeof UpdateProfileBody>;
      return updateTenantProfile(id, body);
    },
  );
}
```

**Step 4: Register the route**

In `src/api/routes/index.ts`:

```ts
import { profileRoutes } from './profile.js';
// inside registerRoutes:
await app.register(profileRoutes, { prefix: '/v1' });
```

**Step 5: Run test to verify pass**

```bash
pnpm test:integration -- tests/integration/tenant-profile-api.integration.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
pnpm typecheck && pnpm lint:fix
git add src/api/routes/profile.ts src/api/routes/index.ts tests/integration/tenant-profile-api.integration.test.ts
git commit -m "feat(api): GET/PUT /tenants/:id/profile (Layer 1: tenant profile + timezone)"
```

---

## Task 11: API — Skill Packs CRUD route

**Files:**

- Create: `src/api/routes/skill-packs.ts`
- Modify: `src/api/routes/index.ts`
- Test: `tests/integration/skill-packs-api.integration.test.ts`

**Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildTestServer } from './helpers/server.js';
import { db } from '../../src/db/client.js';
import { tenantMembers, tenantSkillPacks, tenants } from '../../src/db/schema/index.js';

describe('skill-packs API', () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>;
  let tenantId: string;
  let authHeaders: Record<string, string>;

  beforeEach(async () => {
    ({ app, tenantId, authHeaders } = await setupTenantWithMember());
  });

  afterEach(async () => {
    await db.delete(tenantSkillPacks).where(eq(tenantSkillPacks.tenantId, tenantId));
    await db.delete(tenantMembers).where(eq(tenantMembers.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
  });

  async function create(payload: object) {
    return app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/skill-packs`,
      headers: authHeaders,
      payload,
    });
  }

  it('POST creates and returns 201', async () => {
    const res = await create({
      key: 'tenant.brand-guide',
      name: 'Brand Guide',
      body: '# Voice\n\nWarm.',
      appliesTo: ['shopify-blog-writer'],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().key).toBe('tenant.brand-guide');
  });

  it('rejects key without tenant. prefix', async () => {
    const res = await create({
      key: 'eeat',
      name: 'X',
      body: 'b',
      appliesTo: [],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown agent id in appliesTo', async () => {
    const res = await create({
      key: 'tenant.x',
      name: 'X',
      body: 'b',
      appliesTo: ['ghost-agent'],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects oversize body (>64KB)', async () => {
    const res = await create({
      key: 'tenant.huge',
      name: 'Huge',
      body: 'x'.repeat(64 * 1024 + 1),
      appliesTo: [],
    });
    expect(res.statusCode).toBe(400);
  });

  it('409 on duplicate (tenant, key)', async () => {
    await create({ key: 'tenant.dup', name: 'A', body: 'a', appliesTo: [] });
    const res = await create({ key: 'tenant.dup', name: 'B', body: 'b', appliesTo: [] });
    expect(res.statusCode).toBe(409);
  });

  it('GET list returns created packs', async () => {
    await create({ key: 'tenant.a', name: 'A', body: 'a', appliesTo: [] });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/skill-packs`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((p: { key: string }) => p.key)).toContain('tenant.a');
  });

  it('PUT updates and DELETE removes', async () => {
    const created = await create({ key: 'tenant.k', name: 'K', body: 'old', appliesTo: [] });
    const id = created.json().id;

    const put = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/skill-packs/${id}`,
      headers: authHeaders,
      payload: { body: 'new' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().body).toBe('new');

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/skill-packs/${id}`,
      headers: authHeaders,
    });
    expect(del.statusCode).toBe(204);
  });
});
```

**Step 2: Run test → fail**

```bash
pnpm test:integration -- tests/integration/skill-packs-api.integration.test.ts
```

Expected: FAIL — 404s.

**Step 3: Implement the route**

```ts
// src/api/routes/skill-packs.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentRegistry } from '../../agents/registry.js';
import {
  createPack,
  deletePack,
  getPack,
  listTenantPacks,
  updatePack,
} from '../../agents/skill-packs-repository.js';
import { ConflictError, BadRequestError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';

const BODY_MAX = 64 * 1024;
const KEY_RE = /^tenant\.[a-z0-9-]{1,60}$/;

const TenantIdParam = z.object({ id: z.string().uuid() });
const PackIdParam = z.object({ id: z.string().uuid(), packId: z.string().uuid() });

const PackResponse = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  body: z.string(),
  appliesTo: z.array(z.string()),
  createdAt: z.preprocess(
    (v) => (v instanceof Date ? v.toISOString() : v),
    z.string(),
  ),
  updatedAt: z.preprocess(
    (v) => (v instanceof Date ? v.toISOString() : v),
    z.string(),
  ),
});

function appliesToRefinement(appliesTo: string[], ctx: z.RefinementCtx) {
  const unknown = appliesTo.filter((a) => !agentRegistry.has(a));
  if (unknown.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unknown agent ids: ${unknown.join(', ')}`,
    });
  }
}

const CreateBody = z.object({
  key: z.string().regex(KEY_RE, 'must be tenant.<slug>'),
  name: z.string().min(1).max(120),
  body: z.string().max(BODY_MAX),
  appliesTo: z.array(z.string()).superRefine(appliesToRefinement),
});

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  body: z.string().max(BODY_MAX).optional(),
  appliesTo: z.array(z.string()).superRefine(appliesToRefinement).optional(),
});

export async function skillPacksRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/tenants/:id/skill-packs',
    {
      schema: {
        tags: ['skill-packs'],
        params: TenantIdParam,
        response: { 200: z.array(PackResponse) },
      },
    },
    async (req) => {
      const { id } = req.params as z.infer<typeof TenantIdParam>;
      return listTenantPacks(id);
    },
  );

  app.post(
    '/tenants/:id/skill-packs',
    {
      schema: {
        tags: ['skill-packs'],
        params: TenantIdParam,
        body: CreateBody,
        response: { 201: PackResponse },
      },
    },
    async (req, reply) => {
      const { id } = req.params as z.infer<typeof TenantIdParam>;
      const body = req.body as z.infer<typeof CreateBody>;
      try {
        const pack = await createPack(id, body);
        reply.code(201);
        return pack;
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: string }).code === '23505'
        ) {
          throw new ConflictError(`Pack key ${body.key} already exists`);
        }
        throw err;
      }
    },
  );

  app.get(
    '/tenants/:id/skill-packs/:packId',
    {
      schema: {
        tags: ['skill-packs'],
        params: PackIdParam,
        response: { 200: PackResponse },
      },
    },
    async (req) => {
      const { id, packId } = req.params as z.infer<typeof PackIdParam>;
      return getPack(id, packId);
    },
  );

  app.put(
    '/tenants/:id/skill-packs/:packId',
    {
      schema: {
        tags: ['skill-packs'],
        params: PackIdParam,
        body: UpdateBody,
        response: { 200: PackResponse },
      },
    },
    async (req) => {
      const { id, packId } = req.params as z.infer<typeof PackIdParam>;
      const body = req.body as z.infer<typeof UpdateBody>;
      return updatePack(id, packId, body);
    },
  );

  app.delete(
    '/tenants/:id/skill-packs/:packId',
    {
      schema: {
        tags: ['skill-packs'],
        params: PackIdParam,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const { id, packId } = req.params as z.infer<typeof PackIdParam>;
      await deletePack(id, packId);
      reply.code(204);
      return null;
    },
  );
}
```

(If `BadRequestError` doesn't exist in `src/lib/errors.ts`, drop the import — Zod refinement failures already 400.)

**Step 4: Register the route**

```ts
// src/api/routes/index.ts
import { skillPacksRoutes } from './skill-packs.js';
await app.register(skillPacksRoutes, { prefix: '/v1' });
```

**Step 5: Run test → pass**

```bash
pnpm test:integration -- tests/integration/skill-packs-api.integration.test.ts
```

Expected: PASS (all 7 cases).

**Step 6: Commit**

```bash
pnpm typecheck && pnpm lint:fix
git add src/api/routes/skill-packs.ts src/api/routes/index.ts tests/integration/skill-packs-api.integration.test.ts
git commit -m "feat(api): tenant_skill_packs CRUD — POST/GET/PUT/DELETE /tenants/:id/skill-packs"
```

---

## Task 12: End-to-end sanity — profile + pack actually appear in agent prompt

**Files:**

- Test: `tests/integration/knowledge-layer-e2e.integration.test.ts`

This is the only test that proves the wiring through the orchestrator. Use the existing `FakeChatModel` mock harness (see `tests/integration/helpers/llm-mock.ts`) to capture the system prompt the LLM sees.

**Step 1: Write the test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { tenantSkillPacks, tenants } from '../../src/db/schema/index.js';
import { scriptStructured } from './helpers/llm-mock.js';
// + whatever existing helper kicks off a task and returns the captured prompt

describe('knowledge-layer e2e', () => {
  let tenantId: string;

  beforeEach(async () => {
    const [t] = await db
      .insert(tenants)
      .values({
        name: 'KL Test',
        slug: `kl-${Date.now()}`,
        profileMd: '## Brand voice\n\nWarm, never use the word "synergy".',
        timezone: 'Asia/Taipei',
      })
      .returning();
    tenantId = t!.id;

    await db.insert(tenantSkillPacks).values({
      tenantId,
      key: 'tenant.house-style',
      name: 'House Style',
      body: '## House style\n\nAlways close with a question.',
      appliesTo: ['shopify-blog-writer'],
    });
  });

  afterEach(async () => {
    await db.delete(tenantSkillPacks).where(eq(tenantSkillPacks.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('the writer agent sees tenant profile + tenant pack in its system prompt', async () => {
    // Use the existing test runner that drives a task to its first LLM call
    // and returns the messages handed to FakeChatModel.
    const captured = await runTaskAndCaptureSystemPrompt({
      tenantId,
      agentId: 'shopify-blog-writer',
      brief: 'Write a post about linen shirts',
    });

    const sys = captured.systemMessage;
    expect(sys).toContain('Brand voice');
    expect(sys).toContain('synergy');
    expect(sys).toContain('House Style');
    expect(sys).toContain('close with a question');
    expect(sys).toContain('Asia/Taipei');
  });
});
```

The exact form of `runTaskAndCaptureSystemPrompt` depends on existing helpers — pattern after `tests/integration/shopify-blog-writer.test.ts` which already uses `scriptStructured`. If no helper exposes the system message directly, capture it inside the FakeChatModel itself (fake records each call's first system message).

**Step 2: Run + commit**

```bash
pnpm test:integration -- tests/integration/knowledge-layer-e2e.integration.test.ts
pnpm typecheck && pnpm lint:fix
git add tests/integration/knowledge-layer-e2e.integration.test.ts
git commit -m "test(integration): e2e — tenant profile + pack land in agent system prompt"
```

---

## Task 13: One-shot cleanup script for deprecated config keys

**Files:**

- Create: `scripts/cleanup-deprecated-config-fields.ts`

**Step 1: Implement**

```ts
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { agentConfigs } from '../src/db/schema/index.js';
import { logger } from '../src/lib/logger.js';

/**
 * One-shot: strip deprecated keys (brandTone, bannedPhrases,
 * preferredKeywords, targetLanguages) from agent_configs.config jsonb.
 * Safe to re-run; the `- 'key'` operator is a no-op when the key is absent.
 */
async function main() {
  const result = await db.execute(sql`
    UPDATE agent_configs
    SET config = config
      - 'brandTone'
      - 'bannedPhrases'
      - 'preferredKeywords'
      - 'targetLanguages',
        updated_at = now()
    WHERE config ?| ARRAY['brandTone','bannedPhrases','preferredKeywords','targetLanguages']
  `);
  logger.info({ rowCount: result.rowCount }, 'cleaned deprecated config keys');
  process.exit(0);
}

main().catch((err) => {
  logger.error(err, 'cleanup failed');
  process.exit(1);
});
```

**Step 2: Smoke-test locally**

```bash
pnpm tsx scripts/cleanup-deprecated-config-fields.ts
```

Expected: clean exit. `rowCount` reflects the number of rows touched (0 on a fresh local DB).

**Step 3: Commit**

```bash
git add scripts/cleanup-deprecated-config-fields.ts
git commit -m "chore(scripts): one-shot cleanup of deprecated agent config keys"
```

---

## Task 14: Update `docs/API_GUIDE.md`

**Files:**

- Modify: `docs/API_GUIDE.md`

**Step 1: Add two sections**

Find the table of contents / route summary and add:

- `Tenant Profile` (GET/PUT `/tenants/:id/profile`) with example payloads.
- `Skill Packs` (full CRUD on `/tenants/:id/skill-packs`) with example payloads, the `tenant.<slug>` key constraint, the 32 KB / 64 KB limits, and the `applies_to`-as-activation semantic.

**Step 2: Remove writer-activation references to deprecated fields**

Search `docs/API_GUIDE.md` for `brandTone`, `bannedPhrases`, `preferredKeywords`, `targetLanguages`. Either delete the paragraphs or rewrite them to point users to the tenant profile.

**Step 3: Verify Swagger picks up the new routes**

```bash
pnpm dev &
sleep 3
curl -s http://127.0.0.1:8080/docs/json | jq '.paths | keys' | grep -E 'profile|skill-packs'
kill %1
```

Expected: both `/v1/tenants/{id}/profile` and `/v1/tenants/{id}/skill-packs[/{packId}]` present.

**Step 4: Commit**

```bash
git add docs/API_GUIDE.md
git commit -m "docs(api): document tenant profile + skill packs endpoints"
```

---

## Task 15: Final verification + green check

**Step 1: Full typecheck + lint + test**

```bash
pnpm typecheck && pnpm lint && pnpm test:all
```

Expected: PASS. If anything red, **fix root cause** — do not skip tests or hack around failures.

**Step 2: Re-run migration on a fresh DB**

```bash
supabase db reset
pnpm db:migrate
```

Expected: clean log, no error. Confirms idempotency.

**Step 3: Smoke the e2e via dev server**

```bash
pnpm dev &
sleep 4
# Use a known test tenant id and JWT — pattern after dev README.
curl -X PUT http://127.0.0.1:8080/v1/tenants/<id>/profile \
  -H "Authorization: Bearer <token>" \
  -H "x-tenant-id: <id>" \
  -H "Content-Type: application/json" \
  -d '{"profileMd":"## House voice\n\nWarm.","timezone":"Asia/Taipei"}'
kill %1
```

Expected: 200 with the round-tripped payload.

**Step 4: Final commit if any sweep changes**

```bash
git status                # should be clean
```

If clean, **done**.

---

## Out-of-scope follow-ups

These are deliberately not in this plan:

- **`shopify.list_products` / `shopify.list_articles` tools** — Layer 3 of the design. Add per-agent as needed.
- **Pack templates / marketplace** — curated starter packs.
- **Pack versioning UI** — diff/rollback. Today only `updated_at`.
- **Quota enforcement** — number of packs per tenant. Couples to subscription plan logic that's also TBD.
- **RLS policy update** — tenant_skill_packs needs a policy alongside `tenants` once `withTenantContext` is wired (currently disabled per CLAUDE.md).
