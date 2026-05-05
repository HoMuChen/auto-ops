# Tenant Image Style Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every tenant a single deterministic visual style that is auto-appended to every image-generation prompt, with a vision-LLM helper that turns 1–5 reference images into the suffix.

**Architecture:** Two new structured fields on `tenants` (`image_style_suffix TEXT` + `image_style_reference_image_ids UUID[]`) — paralleling the `timezone` precedent from the tenant knowledge layer. `buildImageTools` reads the suffix at agent build time and appends `\n\nStyle: <suffix>` to every `images.generate` / `images.edit` call. A new `POST /v1/profile/image-style/suggest` endpoint accepts reference image ids and returns a generated suffix via Claude Sonnet vision (through OpenRouter). The suffix is the only value consumed at tool boundary; references are persisted material for re-generation and future Option C (style transfer).

**Tech Stack:** Fastify 5, Drizzle ORM, Postgres (handwritten idempotent migration), Zod (with `fastify-type-provider-zod`), Vitest, OpenAI Images API (gpt-image-2 already wired), OpenRouter via LangChain (`anthropic/claude-sonnet-4.6` for vision).

**Reference design:** [`docs/plans/2026-05-06-image-style-design.md`](./2026-05-06-image-style-design.md)

**Conventions** (carried from the tenant knowledge layer plan, verified):

- Run `pnpm typecheck` before every commit; run `pnpm exec biome check --write <files>` to scope the formatter (the workspace `pnpm lint:fix` sweeps the whole repo).
- Routes MUST declare a `schema` block (tags + body/query + response) so Swagger/OpenAPI stays accurate.
- Drizzle returns `Date`; use `z.preprocess(..., .toISOString())` only when timestamps end up on the wire (these new fields don't carry timestamps).
- Tests are tiered: unit (no DB, no real LLM) vs integration (local Supabase, stubbed `fetch`, mocked LLM via `tests/integration/helpers/llm-mock.ts`).
- "No backward-compat shims" — extend in one commit per surface; no parallel old-and-new field shapes.
- Handwritten migrations re-run on every `pnpm db:migrate`, so use `IF NOT EXISTS` guards.
- Use `tenantOf(req)` (NOT `req.params.id`) for tenant scoping in routes; uphold IDOR safety (analogous to the skill-packs route).

**Branching:** This work depends on `feat/tenant-knowledge-layer` (uses `getTenantProfile` and the `tenant_images` table conventions). Plan to land it on top of that branch (or its merged successor on `main`). At the start of Task 1, confirm `git status` is clean and you are on the right branch.

---

## Task 1: Handwritten migration — `image_style_suffix` + `image_style_reference_image_ids`

**Files:**

- Create: `drizzle/0008_image_style.sql`

**Step 1: Create the migration file**

```sql
-- Tenant-level image style fields. Idempotent — re-runnable on every db:migrate.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS image_style_suffix TEXT NOT NULL DEFAULT '';

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS image_style_reference_image_ids UUID[] NOT NULL DEFAULT '{}';
```

No data carry-forward; new columns get their NOT NULL default applied to every existing row. No new table, no indexes (tiny array per tenant; lookup is always by `tenants.id` via the existing PK).

**Step 2: Run migration locally**

```bash
pnpm db:migrate
```

Expected: clean log "Drizzle migrations complete." then "Applying handwritten SQL migrations…" — no error.

**Step 3: Run a second time to verify idempotency**

```bash
pnpm db:migrate
```

Expected: same clean exit. The second 0008 run logs only `NOTICE: column "image_style_suffix" of relation "tenants" already exists, skipping` etc. — no error, no destructive change.

**Step 4: Verify in psql**

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c '\d tenants' | grep -E "image_style"
```

Expected output:

```
 image_style_suffix              | text                     |       | not null    | ''::text
 image_style_reference_image_ids | uuid[]                   |       | not null    | '{}'::uuid[]
```

**Step 5: Commit**

```bash
git add drizzle/0008_image_style.sql
git commit -m "db(migrate): tenant image style — suffix + reference image ids on tenants"
```

---

## Task 2: Drizzle schema for `tenants` — add the two new fields

**Files:**

- Modify: `src/db/schema/tenants.ts`

**Step 1: Edit the schema**

Add two fields to the existing `tenants` table definition (after `timezone`):

```ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ... existing imports / enums ...

export const tenants = pgTable('tenants', {
  id:        uuid('id').primaryKey().defaultRandom(),
  name:      text('name').notNull(),
  slug:      text('slug').notNull().unique(),
  plan:      text('plan', { enum: subscriptionPlanEnum }).notNull().default('basic'),
  profileMd: text('profile_md').notNull().default(''),
  timezone:  text('timezone').notNull().default('UTC'),
  imageStyleSuffix:             text('image_style_suffix').notNull().default(''),
  imageStyleReferenceImageIds:  uuid('image_style_reference_image_ids')
                                  .array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});
```

**Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS. The compiler will flag any code that destructures `tenants.*` without these fields — there should be zero call sites that need updating yet (Tasks 3+ wire them in).

**Step 3: Commit**

```bash
git add src/db/schema/tenants.ts
git commit -m "db(schema): tenants.image_style_suffix + image_style_reference_image_ids"
```

---

## Task 3: Extend the tenant profile repository to read/write the new fields

**Files:**

- Modify: `src/tenants/profile-repository.ts`
- Modify: `tests/integration/tenant-profile-repository.test.ts`

**Step 1: Update the failing test first**

Open `tests/integration/tenant-profile-repository.test.ts`. Replace the existing 3 cases with 4 (extend the round-trip test and add a defaults assertion for the new fields):

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
      .values({
        name: 'Test',
        slug: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      .returning();
    tenantId = t!.id;
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('returns defaults for a fresh tenant including image style fields', async () => {
    const profile = await getTenantProfile(tenantId);
    expect(profile).toEqual({
      profileMd: '',
      timezone: 'UTC',
      imageStyleSuffix: '',
      imageStyleReferenceImageIds: [],
    });
  });

  it('updates all fields and round-trips', async () => {
    const updated = await updateTenantProfile(tenantId, {
      profileMd: '# Voice\n\nWarm.',
      timezone: 'Asia/Taipei',
      imageStyleSuffix: 'Editorial product photography. Soft daylight.',
      imageStyleReferenceImageIds: [],
    });
    expect(updated.imageStyleSuffix).toContain('Editorial');
    const fetched = await getTenantProfile(tenantId);
    expect(fetched).toEqual(updated);
  });

  it('partial update preserves untouched fields', async () => {
    await updateTenantProfile(tenantId, { profileMd: 'first' });
    const after = await updateTenantProfile(tenantId, {
      imageStyleSuffix: 'White seamless.',
    });
    expect(after.profileMd).toBe('first');
    expect(after.imageStyleSuffix).toBe('White seamless.');
    expect(after.timezone).toBe('UTC');
    expect(after.imageStyleReferenceImageIds).toEqual([]);
  });

  it('updates imageStyleReferenceImageIds array independently', async () => {
    const id1 = '00000000-0000-0000-0000-000000000001';
    const id2 = '00000000-0000-0000-0000-000000000002';
    const after = await updateTenantProfile(tenantId, {
      imageStyleReferenceImageIds: [id1, id2],
    });
    expect(after.imageStyleReferenceImageIds).toEqual([id1, id2]);
  });
});
```

**Step 2: Run to verify failure**

```bash
pnpm test:integration -- tests/integration/tenant-profile-repository.test.ts
```

Expected: FAIL — `Object literal may only specify known properties` (the new fields aren't in `TenantProfile` yet).

**Step 3: Implement the repository extension**

Edit `src/tenants/profile-repository.ts`. Extend the `TenantProfile` type, the `UpdateTenantProfileInput` type, the `getTenantProfile` SELECT, and the `updateTenantProfile` SET builder:

```ts
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenants } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';

export interface TenantProfile {
  profileMd: string;
  timezone: string;
  imageStyleSuffix: string;
  imageStyleReferenceImageIds: string[];
}

export interface UpdateTenantProfileInput {
  profileMd?: string;
  timezone?: string;
  imageStyleSuffix?: string;
  imageStyleReferenceImageIds?: string[];
}

const profileColumns = {
  profileMd: tenants.profileMd,
  timezone: tenants.timezone,
  imageStyleSuffix: tenants.imageStyleSuffix,
  imageStyleReferenceImageIds: tenants.imageStyleReferenceImageIds,
};

export async function getTenantProfile(tenantId: string): Promise<TenantProfile> {
  const [row] = await db
    .select(profileColumns)
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
  if (input.imageStyleSuffix !== undefined) set.imageStyleSuffix = input.imageStyleSuffix;
  if (input.imageStyleReferenceImageIds !== undefined) {
    set.imageStyleReferenceImageIds = input.imageStyleReferenceImageIds;
  }

  const [row] = await db
    .update(tenants)
    .set(set)
    .where(eq(tenants.id, tenantId))
    .returning(profileColumns);
  if (!row) throw new NotFoundError(`Tenant ${tenantId}`);
  return row;
}
```

**Step 4: Run to verify pass**

```bash
pnpm test:integration -- tests/integration/tenant-profile-repository.test.ts
```

Expected: 4/4 PASS.

**Step 5: Commit**

```bash
pnpm exec biome check --write src/tenants/profile-repository.ts tests/integration/tenant-profile-repository.test.ts
git add src/tenants/profile-repository.ts tests/integration/tenant-profile-repository.test.ts
git commit -m "feat(tenants): profile repository — image_style_suffix + reference image ids"
```

---

## Task 4: Extend `GET /v1/profile` and `PUT /v1/profile` for the new fields

**Files:**

- Modify: `src/api/routes/profile.ts`
- Modify: `tests/integration/tenant-profile-api.integration.test.ts`

**Step 1: Update the integration test first**

Append the following test cases to the existing file (keep the existing 5 tests; add these to a new `describe('image style fields')` block):

```ts
describe('image style fields on /v1/profile', () => {
  it('GET includes imageStyleSuffix and imageStyleReferenceImageIds (defaults)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/profile',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      profileMd: '',
      timezone: 'UTC',
      imageStyleSuffix: '',
      imageStyleReferenceImageIds: [],
    });
  });

  it('PUT updates imageStyleSuffix and imageStyleReferenceImageIds', async () => {
    // Insert two reference images owned by this tenant
    const { db } = await import('../../src/db/client.js');
    const { tenantImages } = await import('../../src/db/schema/index.js');
    const [img1] = await db.insert(tenantImages).values({
      tenantId,
      cfImageId: 'cf-1',
      url: 'https://cf.example.com/cf-1',
      sourceType: 'uploaded',
      status: 'ready',
      mimeType: 'image/png',
    }).returning();
    const [img2] = await db.insert(tenantImages).values({
      tenantId,
      cfImageId: 'cf-2',
      url: 'https://cf.example.com/cf-2',
      sourceType: 'uploaded',
      status: 'ready',
      mimeType: 'image/png',
    }).returning();

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers,
      payload: {
        imageStyleSuffix: 'White seamless. Soft daylight from left.',
        imageStyleReferenceImageIds: [img1!.id, img2!.id],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().imageStyleSuffix).toContain('White seamless');
    expect(res.json().imageStyleReferenceImageIds).toEqual([img1!.id, img2!.id]);
  });

  it('rejects oversize imageStyleSuffix (>2KB)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers,
      payload: { imageStyleSuffix: 'x'.repeat(2 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects more than 5 reference image ids', async () => {
    const six = Array.from({ length: 6 }, (_, i) =>
      `00000000-0000-0000-0000-00000000000${i}`,
    );
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers,
      payload: { imageStyleReferenceImageIds: six },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects reference image id that belongs to another tenant (IDOR guard)', async () => {
    // Create a SECOND tenant + an image owned by them
    const { seedTenantWithOwner } = await import('./helpers/db.js');
    const { db } = await import('../../src/db/client.js');
    const { tenantImages } = await import('../../src/db/schema/index.js');
    const otherSeed = await seedTenantWithOwner();
    const [otherImg] = await db.insert(tenantImages).values({
      tenantId: otherSeed.tenantId,
      cfImageId: 'cf-other',
      url: 'https://cf.example.com/cf-other',
      sourceType: 'uploaded',
      status: 'ready',
      mimeType: 'image/png',
    }).returning();

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers,  // authenticated as the FIRST tenant
      payload: { imageStyleReferenceImageIds: [otherImg!.id] },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

**Step 2: Run to verify failure**

```bash
pnpm test:integration -- tests/integration/tenant-profile-api.integration.test.ts
```

Expected: 4 of the 5 new tests fail (the GET defaults test depends on response schema; the PUT/validation tests fail because the route schema doesn't accept the new fields).

**Step 3: Extend `src/api/routes/profile.ts`**

Add constants, expand the response and update body schemas, and add a refinement helper that validates reference image ownership:

```ts
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { tenantImages } from '../../db/schema/index.js';
import {
  getTenantProfile,
  updateTenantProfile,
} from '../../tenants/profile-repository.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, tenantOf } from '../middleware/tenant.js';

const PROFILE_MD_MAX = 32 * 1024;
const STYLE_SUFFIX_MAX = 2 * 1024;
const MAX_REFERENCE_IMAGES = 5;
const validTimezones = new Set(Intl.supportedValuesOf('timeZone'));

const ProfileResponse = z.object({
  profileMd: z.string(),
  timezone: z.string(),
  imageStyleSuffix: z.string(),
  imageStyleReferenceImageIds: z.array(z.string().uuid()),
});

const UpdateProfileBody = z.object({
  profileMd: z.string().max(PROFILE_MD_MAX).optional(),
  timezone: z
    .string()
    .refine((tz) => validTimezones.has(tz), 'invalid IANA timezone')
    .optional(),
  imageStyleSuffix: z.string().max(STYLE_SUFFIX_MAX).optional(),
  imageStyleReferenceImageIds: z
    .array(z.string().uuid())
    .max(MAX_REFERENCE_IMAGES)
    .optional(),
});

/**
 * Verify each id in `ids` exists in tenant_images AND belongs to `tenantId`.
 * Throws BadRequestError with the offending ids when validation fails.
 */
async function assertReferenceImagesOwned(
  tenantId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: tenantImages.id })
    .from(tenantImages)
    .where(inArray(tenantImages.id, ids));
  const owned = new Set(
    (await db
      .select({ id: tenantImages.id })
      .from(tenantImages)
      .where(eq(tenantImages.tenantId, tenantId)))
      .map((r) => r.id),
  );
  const missingOrForeign = ids.filter((id) => !owned.has(id));
  if (missingOrForeign.length > 0) {
    const err = new Error(
      `Reference image ids not owned by tenant: ${missingOrForeign.join(', ')}`,
    );
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/profile',
    {
      schema: {
        tags: ['tenants'],
        response: { 200: ProfileResponse },
      },
    },
    async (req) => getTenantProfile(tenantOf(req)),
  );

  app.put(
    '/profile',
    {
      schema: {
        tags: ['tenants'],
        body: UpdateProfileBody,
        response: { 200: ProfileResponse },
      },
    },
    async (req) => {
      const body = req.body as z.infer<typeof UpdateProfileBody>;
      if (body.imageStyleReferenceImageIds) {
        await assertReferenceImagesOwned(
          tenantOf(req),
          body.imageStyleReferenceImageIds,
        );
      }
      return updateTenantProfile(tenantOf(req), body);
    },
  );
}
```

(The `assertReferenceImagesOwned` helper does **two** queries — one to confirm ids exist, one to filter by tenant. The second query alone is sufficient since `tenant_images.id` is unique; you can simplify to a single query that filters by both `inArray(id, ids)` AND `eq(tenantId, ...)`. Choose whichever is clearer; the test asserts the same outcome either way.)

**Step 4: Run to verify pass**

```bash
pnpm test:integration -- tests/integration/tenant-profile-api.integration.test.ts
```

Expected: all 9 tests PASS (5 existing + 4 new).

**Step 5: Run full suite**

```bash
pnpm typecheck && pnpm test:integration
```

Expected: typecheck clean; full integration suite green.

**Step 6: Commit**

```bash
pnpm exec biome check --write src/api/routes/profile.ts tests/integration/tenant-profile-api.integration.test.ts
git add src/api/routes/profile.ts tests/integration/tenant-profile-api.integration.test.ts
git commit -m "feat(api): /v1/profile carries image_style_suffix + reference image ids (with IDOR guard)"
```

---

## Task 5: Append `styleSuffix` to every prompt at the `buildImageTools` boundary

**Files:**

- Modify: `src/integrations/openai-images/tools.ts`
- Modify: `tests/openai-images-tools.test.ts` (or create if absent — verify path before starting)

**Step 1: Locate the existing tools test**

```bash
ls tests/ | grep -i openai
```

If `tests/openai-images-tools.test.ts` doesn't exist, look for tests under `tests/image-tools.test.ts` or similar — check `tests/` directly. There IS an existing test file at `tests/openai-images-client.test.ts` and `tests/image-tools.test.ts`. The latter is where the buildImageTools tests live.

**Step 2: Add failing tests to `tests/image-tools.test.ts`**

Append two cases inside the existing `describe('buildImageTools')` block:

```ts
it('appends styleSuffix to generate prompt when supplied', async () => {
  const generatedPrompt: string[] = [];
  const fakeOpenai = {
    generate: vi.fn(async (opts: { prompt: string }) => {
      generatedPrompt.push(opts.prompt);
      return Buffer.from('fake-image');
    }),
    edit: vi.fn(),
  } as unknown as OpenAIImagesClient;
  const fakeCf = {
    upload: vi.fn(async () => ({ cfImageId: 'cf-id', url: 'https://x/y' })),
  } as unknown as CloudflareImagesClient;

  const tools = buildImageTools('tenant-1', {
    openaiClient: fakeOpenai,
    cfClient: fakeCf,
    insertImage: vi.fn(async (input) => ({ id: 'img-1', ...input } as never)),
    styleSuffix: 'White seamless backdrop. Soft daylight from left.',
  });
  const generate = tools.find((t) => t.id === 'images.generate')!;

  await generate.tool.invoke({ prompt: 'linen shirt on a marble countertop' });

  expect(generatedPrompt[0]).toBe(
    'linen shirt on a marble countertop\n\nStyle: White seamless backdrop. Soft daylight from left.',
  );
});

it('omits style block when styleSuffix is empty / undefined', async () => {
  const generatedPrompt: string[] = [];
  const fakeOpenai = {
    generate: vi.fn(async (opts: { prompt: string }) => {
      generatedPrompt.push(opts.prompt);
      return Buffer.from('fake-image');
    }),
    edit: vi.fn(),
  } as unknown as OpenAIImagesClient;
  const fakeCf = {
    upload: vi.fn(async () => ({ cfImageId: 'cf-id', url: 'https://x/y' })),
  } as unknown as CloudflareImagesClient;

  const tools = buildImageTools('tenant-1', {
    openaiClient: fakeOpenai,
    cfClient: fakeCf,
    insertImage: vi.fn(async (input) => ({ id: 'img-1', ...input } as never)),
    // no styleSuffix
  });
  const generate = tools.find((t) => t.id === 'images.generate')!;

  await generate.tool.invoke({ prompt: 'minimalist hero shot' });

  expect(generatedPrompt[0]).toBe('minimalist hero shot');
});
```

(If `vi`, `OpenAIImagesClient`, `CloudflareImagesClient` aren't imported in the existing test file, add them.)

**Step 3: Run to verify failure**

```bash
pnpm test -- tests/image-tools.test.ts
```

Expected: the two new cases fail because `styleSuffix` isn't a recognized option.

**Step 4: Update `src/integrations/openai-images/tools.ts`**

Add `styleSuffix?: string` to `BuildImageToolsOpts`, then build a small helper and use it in BOTH `images_generate` and `images_edit`:

```ts
export interface BuildImageToolsOpts {
  openaiClient: OpenAIImagesClient;
  cfClient: CloudflareImagesClient;
  insertImage: (input: Omit<NewTenantImage, 'id' | 'createdAt'>) => Promise<TenantImage>;
  getImageById?: (tenantId: string, id: string) => Promise<TenantImage | null>;
  fetchImageBuffer?: (url: string) => Promise<Buffer>;
  taskId?: string;
  /**
   * Tenant-level style suffix. Appended to every generated/edited image prompt
   * as `\n\nStyle: <suffix>`. Empty / undefined → no-op (no "Style:" block).
   */
  styleSuffix?: string;
}

function withStyle(prompt: string, styleSuffix?: string): string {
  if (!styleSuffix) return prompt;
  return `${prompt}\n\nStyle: ${styleSuffix}`;
}

// inside the generate tool implementation:
const buffer = await opts.openaiClient.generate({
  prompt: withStyle(input.prompt, opts.styleSuffix),
  size: (input.size as '1024x1024') ?? '1024x1024',
  quality: (input.quality as 'medium') ?? 'medium',
});

// inside the edit tool implementation:
const buffer = await opts.openaiClient.edit({
  imageBuffer: sourceBuffer,
  prompt: withStyle(input.prompt, opts.styleSuffix),
});
```

**Step 5: Run to verify pass**

```bash
pnpm test -- tests/image-tools.test.ts
```

Expected: all tests PASS.

**Step 6: Run full unit suite**

```bash
pnpm test
```

Expected: full unit suite still green.

**Step 7: Commit**

```bash
pnpm exec biome check --write src/integrations/openai-images/tools.ts tests/image-tools.test.ts
git add src/integrations/openai-images/tools.ts tests/image-tools.test.ts
git commit -m "feat(images): buildImageTools appends tenant styleSuffix to every prompt"
```

---

## Task 6: Wire `styleSuffix` into `product-designer`

**Files:**

- Modify: `src/agents/builtin/product-designer/index.ts`

**Step 1: Read the current call site**

Open `src/agents/builtin/product-designer/index.ts`. Find the `buildImageTools(...)` invocation (around line 133). It looks like:

```ts
const imageTools =
  r2Ready && openaiKey
    ? buildImageTools(ctx.tenantId, {
        openaiClient: new OpenAIImagesClient({ apiKey: openaiKey }),
        cfClient: new CloudflareImagesClient({ ... }),
        insertImage,
        getImageById,
        fetchImageBuffer: async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()),
        taskId: ctx.taskId,
      })
    : [];
```

**Step 2: Fetch the tenant profile and pass `styleSuffix`**

Above the `imageTools` block, add:

```ts
const profile = await getTenantProfile(ctx.tenantId);
```

Add the import at the top of the file:

```ts
import { getTenantProfile } from '../../../tenants/profile-repository.js';
```

Then extend the `buildImageTools` opts:

```ts
const imageTools =
  r2Ready && openaiKey
    ? buildImageTools(ctx.tenantId, {
        openaiClient: new OpenAIImagesClient({ apiKey: openaiKey }),
        cfClient: new CloudflareImagesClient({ ... }),
        insertImage,
        getImageById,
        fetchImageBuffer: async (url) =>
          Buffer.from(await (await fetch(url)).arrayBuffer()),
        taskId: ctx.taskId,
        styleSuffix: profile.imageStyleSuffix || undefined,
      })
    : [];
```

The `|| undefined` collapses an empty string to `undefined` so the tool wrapper's "no-op when falsy" check stays clean.

**Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

**Step 4: Run unit + integration tests for the agent**

```bash
pnpm test -- tests/product-designer.test.ts
pnpm test:integration -- tests/integration/product-publisher.test.ts
```

Expected: both PASS. The unit test already mocks `skill-packs-repository`; you may need to also mock `profile-repository` if `getTenantProfile` triggers a real DB call inside the unit test. Check the test output — if it errors with a DB connection, add this mock at the top of `tests/product-designer.test.ts` (mirror the existing `vi.mock('../src/agents/skill-packs-repository.js', ...)` pattern):

```ts
vi.mock('../src/tenants/profile-repository.js', () => ({
  getTenantProfile: vi.fn(async () => ({
    profileMd: '',
    timezone: 'UTC',
    imageStyleSuffix: '',
    imageStyleReferenceImageIds: [],
  })),
}));
```

**Step 5: Commit**

```bash
pnpm exec biome check --write src/agents/builtin/product-designer/index.ts tests/product-designer.test.ts
git add src/agents/builtin/product-designer/index.ts tests/product-designer.test.ts
git commit -m "feat(product-designer): pass tenant imageStyleSuffix to buildImageTools"
```

---

## Task 7: Wire `styleSuffix` into `shopify-blog-writer` (cover image)

**Files:**

- Modify: `src/agents/builtin/shopify-blog-writer/index.ts`

**Step 1: Find the `buildImageTools(...)` call**

In `src/agents/builtin/shopify-blog-writer/index.ts`, locate the imageTools block (around line 250). Same shape as `product-designer`.

**Step 2: Fetch the profile and pass styleSuffix**

```ts
import { getTenantProfile } from '../../../tenants/profile-repository.js';

// inside build():
const profile = await getTenantProfile(ctx.tenantId);

const imageTools =
  r2Ready && openaiKey
    ? buildImageTools(ctx.tenantId, {
        // ... existing opts
        taskId: ctx.taskId,
        styleSuffix: profile.imageStyleSuffix || undefined,
      })
    : [];
```

The agent's `cfg.coverImageStyle` continues to be a per-task scene note appended to the LLM-supplied prompt:

```ts
prompt: `Blog cover image for: "${article.title}". ${cfg.coverImageStyle ?? ''}`
```

…and the wrapper then adds the tenant `Style:` block on top. No code change to that line — it already works; the wrapper does the appending automatically.

**Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

**Step 4: Run blog-writer tests**

```bash
pnpm test:integration -- tests/integration/shopify-blog-writer.test.ts tests/integration/shopify-blog-writer-eeat.test.ts
```

Expected: both PASS. (No unit-tier writer test exists; integration tests use real DB tenants so `getTenantProfile` returns empty defaults.)

**Step 5: Commit**

```bash
pnpm exec biome check --write src/agents/builtin/shopify-blog-writer/index.ts
git add src/agents/builtin/shopify-blog-writer/index.ts
git commit -m "feat(blog-writer): pass tenant imageStyleSuffix to buildImageTools"
```

---

## Task 8: `POST /v1/profile/image-style/suggest` — vision LLM helper

**Files:**

- Modify: `src/api/routes/profile.ts`
- Modify: `tests/integration/tenant-profile-api.integration.test.ts`

**Step 1: Add failing integration tests**

Append to the existing test file (inside a new `describe('POST /v1/profile/image-style/suggest')` block):

```ts
import { scriptStructured } from './helpers/llm-mock.js';

describe('POST /v1/profile/image-style/suggest', () => {
  it('returns a suggested suffix from vision LLM', async () => {
    const { db } = await import('../../src/db/client.js');
    const { tenantImages } = await import('../../src/db/schema/index.js');
    const [img] = await db.insert(tenantImages).values({
      tenantId,
      cfImageId: 'cf-1',
      url: 'https://cf.example.com/cf-1',
      sourceType: 'uploaded',
      status: 'ready',
      mimeType: 'image/png',
    }).returning();

    scriptStructured({ suffix: 'Editorial product photography. Soft daylight. White seamless.' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/profile/image-style/suggest',
      headers,
      payload: { referenceImageIds: [img!.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestedSuffix).toContain('Editorial');
  });

  it('rejects empty referenceImageIds (zod min(1))', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/profile/image-style/suggest',
      headers,
      payload: { referenceImageIds: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects more than 5 referenceImageIds', async () => {
    const six = Array.from({ length: 6 }, (_, i) =>
      `00000000-0000-0000-0000-00000000000${i}`,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/profile/image-style/suggest',
      headers,
      payload: { referenceImageIds: six },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects reference id from another tenant (IDOR guard)', async () => {
    const { seedTenantWithOwner } = await import('./helpers/db.js');
    const { db } = await import('../../src/db/client.js');
    const { tenantImages } = await import('../../src/db/schema/index.js');
    const otherSeed = await seedTenantWithOwner();
    const [otherImg] = await db.insert(tenantImages).values({
      tenantId: otherSeed.tenantId,
      cfImageId: 'cf-other',
      url: 'https://cf.example.com/cf-other',
      sourceType: 'uploaded',
      status: 'ready',
      mimeType: 'image/png',
    }).returning();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/profile/image-style/suggest',
      headers,  // first tenant
      payload: { referenceImageIds: [otherImg!.id] },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

**Note**: this test file already mocks `model-registry` via `vi.mock('../../src/llm/model-registry.js', () => llmMockModule())`. If it doesn't, add that line at the top alongside the existing imports — see `tests/integration/lifecycle.test.ts` for the canonical pattern.

**Step 2: Run to verify failure**

```bash
pnpm test:integration -- tests/integration/tenant-profile-api.integration.test.ts
```

Expected: 4 new tests fail with 404 (route doesn't exist).

**Step 3: Implement the suggest endpoint**

Append to `src/api/routes/profile.ts` (inside `profileRoutes`):

```ts
import { buildModel } from '../../llm/model-registry.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

const VISION_SYSTEM_PROMPT = `You extract visual style guidelines from a brand's reference images. Output ONE dense prose paragraph (80–200 words) capturing: photography genre (editorial / product / lifestyle / studio), lighting (direction, quality), color palette and mood, composition rules (centered / rule-of-thirds / copy space), background, props and models, finish (clean / film grain). The output will be appended verbatim to image-generation prompts — write it as instructions to an image model. No headings, no bullets, no quote marks. One paragraph only.`;

const SuggestBody = z.object({
  referenceImageIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_REFERENCE_IMAGES),
  hint: z.string().max(500).optional(),
});

const SuggestResponse = z.object({
  suggestedSuffix: z.string(),
});

const SuffixSchema = z.object({
  suffix: z.string().min(20).max(2000),
});

// Inside profileRoutes:
app.post(
  '/profile/image-style/suggest',
  {
    schema: {
      tags: ['tenants'],
      body: SuggestBody,
      response: { 200: SuggestResponse },
    },
  },
  async (req) => {
    const tenantId = tenantOf(req);
    const body = req.body as z.infer<typeof SuggestBody>;

    // Resolve images, scoped by tenant — enforces IDOR
    const rows = await db
      .select({ id: tenantImages.id, url: tenantImages.url })
      .from(tenantImages)
      .where(
        and(
          eq(tenantImages.tenantId, tenantId),
          inArray(tenantImages.id, body.referenceImageIds),
        ),
      );
    if (rows.length !== body.referenceImageIds.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = body.referenceImageIds.filter((id) => !found.has(id));
      const err = new Error(
        `Reference image ids not owned by tenant: ${missing.join(', ')}`,
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const model = buildModel({
      model: 'anthropic/claude-sonnet-4.6',
      temperature: 0.2,
    }).withStructuredOutput(SuffixSchema, { name: 'image_style_suffix' });

    const userContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    > = [
      { type: 'text', text: body.hint ?? 'Describe the visual style.' },
      ...rows.map((r) => ({
        type: 'image_url' as const,
        image_url: { url: r.url },
      })),
    ];

    const result = await model.invoke([
      new SystemMessage(VISION_SYSTEM_PROMPT),
      new HumanMessage({ content: userContent }),
    ]);

    return { suggestedSuffix: result.suffix };
  },
);
```

Also add the missing imports at the top of the file:

```ts
import { and } from 'drizzle-orm';
```

(`eq`, `inArray`, `db`, `tenantImages` are already imported from Task 4.)

**Step 4: Run to verify pass**

```bash
pnpm test:integration -- tests/integration/tenant-profile-api.integration.test.ts
```

Expected: all tests PASS (5 original + 4 PUT tests + 4 suggest tests = 13).

**Step 5: Run full integration suite**

```bash
pnpm test:integration
```

Expected: green.

**Step 6: Commit**

```bash
pnpm exec biome check --write src/api/routes/profile.ts tests/integration/tenant-profile-api.integration.test.ts
git add src/api/routes/profile.ts tests/integration/tenant-profile-api.integration.test.ts
git commit -m "feat(api): POST /v1/profile/image-style/suggest — vision LLM produces suffix from references"
```

---

## Task 9: E2E test — verify suffix actually reaches OpenAI

**Files:**

- Create: `tests/integration/image-style-e2e.integration.test.ts`

**Step 1: Write the test**

Pattern after `tests/integration/knowledge-layer-e2e.integration.test.ts`. The strategy: spy on `OpenAIImagesClient.prototype.generate` and verify the captured `prompt` contains a tenant-specific marker.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import {
  clearScript,
  llmMockModule,
  scriptStructured,
  scriptToolCall,
} from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

// Spy on OpenAI image generation BEFORE importing anything that builds tools
const generateSpy = vi.fn(async () => Buffer.from('fake-image'));
vi.mock('../../src/integrations/openai-images/client.js', async (orig) => {
  const actual = await orig<typeof import('../../src/integrations/openai-images/client.js')>();
  class MockOpenAIImagesClient extends actual.OpenAIImagesClient {
    override generate = generateSpy;
  }
  return { ...actual, OpenAIImagesClient: MockOpenAIImagesClient };
});

// Stub R2 / Cloudflare uploads
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

const { createTestApp } = await import('./helpers/app.js');
const { db } = await import('../../src/db/client.js');
const { tenants } = await import('../../src/db/schema/index.js');
const { eq } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll();
  clearScript();
  generateSpy.mockClear();
});

describe('image style e2e', () => {
  it('tenant.image_style_suffix appears verbatim in OpenAI generate prompt', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const MARKER = 'TENANT_STYLE_MARKER_2026';
    await db.update(tenants).set({ imageStyleSuffix: MARKER }).where(eq(tenants.id, tenantId));

    const jwt = await mintJwt({ userId, email });
    const hdrs = authHeaders(jwt, tenantId);

    // Activate product-designer (no credentials needed; designer's required list is empty)
    await app.inject({
      method: 'POST',
      url: '/v1/agents/product-designer/activate',
      headers: hdrs,
      payload: { config: {} },
    });

    // Activate the publisher kid agent so the designer can spawn at end
    // (Optional; the test may complete with a single image generation before the spawn step.
    //  If your run requires it, also activate shopify-publisher with appropriate credentials.)

    // Script: supervisor route → designer → designer calls images_generate
    scriptStructured({ nextAgent: 'product-designer', clarification: null, done: false });
    scriptToolCall('images_generate', { prompt: 'minimalist hero shot of a linen shirt' });
    // Stub out the final structured output the designer eventually produces.
    // (You may need additional script entries depending on the designer's flow.
    //  At minimum, ensure the LLM mock has enough scripted entries to drive the
    //  agent at least past the image generation step.)

    const taskRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: hdrs,
      payload: { brief: 'Design a hero shot for our linen shirt', agentId: 'product-designer' },
    });
    expect(taskRes.statusCode).toBe(201);

    await drainNextTask();

    // Inspect what generateSpy received
    expect(generateSpy).toHaveBeenCalled();
    const firstCall = generateSpy.mock.calls[0]?.[0] as { prompt: string } | undefined;
    expect(firstCall?.prompt).toContain('linen shirt');           // LLM-supplied
    expect(firstCall?.prompt).toContain(`Style: ${MARKER}`);       // tenant suffix
  });
});
```

**Note:** the script for `product-designer` may require more entries than shown depending on its current flow (the agent typically generates an image, then produces structured output, then optionally spawns publisher tasks). The test only needs to drive far enough to capture **one** `generateSpy` call. If the test fails because the script runs out, look at `tests/integration/product-publisher.test.ts` for a complete reference of how many script entries the designer needs and clone the relevant pattern.

**Step 2: Run the test**

```bash
pnpm test:integration -- tests/integration/image-style-e2e.integration.test.ts
```

Expected: PASS. If it fails on script depletion, extend the script entries until the spy captures at least one call.

**Step 3: Commit**

```bash
pnpm exec biome check --write tests/integration/image-style-e2e.integration.test.ts
git add tests/integration/image-style-e2e.integration.test.ts
git commit -m "test(integration): e2e — tenant image_style_suffix reaches OpenAI generate prompt"
```

---

## Task 10: Update `docs/API_GUIDE.md`

**Files:**

- Modify: `docs/API_GUIDE.md`

**Step 1: Extend the existing Tenant Profile section**

Find the **Tenant Profile** section (added in the prior plan's Task 14). Update the response/request shape examples to include the two new fields:

```json
{
  "profileMd": "...",
  "timezone": "Asia/Taipei",
  "imageStyleSuffix": "Editorial product photography. Soft daylight from left. White seamless backdrop.",
  "imageStyleReferenceImageIds": ["uuid-1", "uuid-2"]
}
```

Note the limits:
- `imageStyleSuffix` ≤ 2 KB
- `imageStyleReferenceImageIds`: 0–5 entries; each id must belong to the caller's tenant (otherwise 400)

**Step 2: Add the suggest endpoint section**

Below the Tenant Profile section, add:

```markdown
### Suggest image style from references

`POST /v1/profile/image-style/suggest`

Pass 1–5 reference image ids (uploaded via `POST /v1/uploads`) plus an optional hint, and the system returns a suggested style-suffix string for the user to review and save.

**Request:**
```json
{
  "referenceImageIds": ["uuid-1", "uuid-2"],
  "hint": "more editorial, less commercial"
}
```

**Response:**
```json
{
  "suggestedSuffix": "Editorial product photography. Warm natural daylight from the left. Off-white seamless backdrop. Centered composition with negative space. Minimal props. Slight film grain."
}
```

The user is expected to review and edit the suffix, then save it via `PUT /v1/profile`. The endpoint does **not** auto-write the suffix — it returns a suggestion only.
```

**Step 3: Commit**

```bash
git add docs/API_GUIDE.md
git commit -m "docs(api): document image_style_suffix + suggest endpoint"
```

---

## Task 11: Final verification

**Step 1: Full typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: both PASS.

**Step 2: Full test suite**

```bash
pnpm test:all
```

Expected: unit + integration green.

**Step 3: Migration idempotency**

```bash
supabase db reset && pnpm db:migrate && pnpm db:migrate
```

Expected: clean exit on both runs.

**Step 4: No regressions in prior knowledge-layer e2e**

```bash
pnpm test:integration -- tests/integration/knowledge-layer-e2e.integration.test.ts tests/integration/image-style-e2e.integration.test.ts
```

Expected: both green — proves the two layers compose without interfering.

**Step 5: Working tree clean**

```bash
git status
```

Expected: nothing to commit, working tree clean.

If any step fails, fix the root cause; do not skip tests or hack around failures.

---

## Out-of-scope follow-ups

- **Option C** — actual style transfer via gpt-image-2's image-conditioning parameter, using `imageStyleReferenceImageIds` as the source. The schema already supports this; it's a one-task addition when the feature is needed.
- **Multi-preset styles** — convert `image_style_suffix TEXT` to FK on a new `tenant_image_styles` table. One migration, no API breakage if defaults preserved.
- **Suffix length tuning** — empirically adjust the 2 KB cap once real tenants are saving.
- **Analytics on suggest cost** — track tokens-in (image bytes) per suggest call, surface in admin panel. Not required for V1.
