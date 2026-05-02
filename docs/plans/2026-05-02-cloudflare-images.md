# Cloudflare Images Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Wire Cloudflare Images as CDN storage for all tenant images: user uploads (intake/task), AI-generated product images (shopify-ops), and blog cover images (blog-writer), with automatic vision capability for agents that receive image attachments.

**Architecture:** A `tenant_images` table is the single source of truth; messages/tasks carry UUID refs in JSONB `imageIds[]`. User uploads go through `POST /v1/uploads` (proxy → CF). Agent generation calls OpenAI `gpt-image-1` → uploads to CF → inserts row. `buildAgentMessages` becomes async and resolves imageIds to `image_url` content blocks so any vision-capable agent can see attached photos automatically.

**Tech Stack:** Fastify 5 · Drizzle ORM · TypeScript · Vitest · OpenAI Images API (`gpt-image-1`) · Cloudflare Images REST API · LangChain BaseMessage

**Design Doc:** `docs/plans/2026-05-02-cloudflare-images-design.md`

**Read before starting:**
- `src/integrations/serper/client.ts` — injectable fetch pattern to copy
- `src/integrations/shopify/tools.ts` — AgentTool shape to copy
- `src/agents/lib/messages.ts` — current `buildAgentMessages` (to extend)
- `src/orchestrator/graph.ts:82-100` — how agent nodes build `AgentInput`
- `src/tasks/runner.ts` — how initial GraphState is seeded
- `tests/integration/helpers/db.ts` — `truncateAll`, `seedTenant` patterns

---

## Section A — Foundations

### Task 1: New env vars

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`

**Step 1: Add to `envSchema` in `src/config/env.ts`**

After the existing `CLOUDFLARE_IMAGES_TOKEN` line add:

```ts
/**
 * CF Images account hash — appears in image delivery URLs:
 * https://imagedelivery.net/{CLOUDFLARE_IMAGES_HASH}/{imageId}/{variant}
 * Read from the `result.variants[0]` URL of any CF Images upload response.
 */
CLOUDFLARE_IMAGES_HASH: z.string().optional(),

/** OpenAI API key — used for gpt-image-1 image generation and editing. */
OPENAI_API_KEY: z.string().min(1).optional(),
```

**Step 2: Append to `.env.example`**

```
# Cloudflare Images delivery hash (distinct from account ID).
# Read from the delivery URL of any CF Images upload: imagedelivery.net/{hash}/...
CLOUDFLARE_IMAGES_HASH=

# OpenAI API key — image generation via gpt-image-1
OPENAI_API_KEY=
```

**Step 3: Typecheck**
```bash
pnpm typecheck
```
Expected: no errors.

**Step 4: Commit**
```bash
git add src/config/env.ts .env.example
git commit -m "feat(config): add CLOUDFLARE_IMAGES_HASH and OPENAI_API_KEY env vars"
```

---

### Task 2: `tenant_images` schema + migration

**Files:**
- Create: `src/db/schema/images.ts`
- Modify: `src/db/schema/index.ts`
- Modify: `tests/integration/helpers/db.ts`

**Step 1: Create `src/db/schema/images.ts`**

```ts
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tasks } from './tasks.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const imageSourceTypeEnum = ['uploaded', 'generated', 'edited'] as const;
export const imageStatusEnum = ['pending', 'ready', 'failed'] as const;

export const tenantImages = pgTable(
  'tenant_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cfImageId: text('cf_image_id').notNull(),
    url: text('url').notNull(),
    sourceType: text('source_type', { enum: imageSourceTypeEnum }).notNull(),
    status: text('status', { enum: imageStatusEnum }).notNull().default('ready'),
    prompt: text('prompt'),
    sourceImageId: uuid('source_image_id'),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    mimeType: text('mime_type'),
    fileSize: integer('file_size'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCreatedIdx: index('tenant_images_tenant_created_idx').on(
      table.tenantId,
      table.createdAt,
    ),
    taskIdx: index('tenant_images_task_idx').on(table.taskId),
    sourceIdx: index('tenant_images_source_idx').on(table.sourceImageId),
  }),
);

export type TenantImage = typeof tenantImages.$inferSelect;
export type NewTenantImage = typeof tenantImages.$inferInsert;
```

**Step 2: Export from `src/db/schema/index.ts`**

Append: `export * from './images.js';`

**Step 3: Generate and apply migration**
```bash
pnpm db:generate
pnpm db:migrate
```
Expected: new migration file appears in `drizzle/`, `pnpm db:migrate` exits 0.

**Step 4: Add `tenant_images` to truncate list in `tests/integration/helpers/db.ts`**

Find `APP_TABLES` array and add `'tenant_images'` as the first entry (before `serp_cache`).

**Step 5: Verify**
```bash
pnpm typecheck
```

**Step 6: Commit**
```bash
git add src/db/schema/images.ts src/db/schema/index.ts drizzle/ tests/integration/helpers/db.ts
git commit -m "feat(db): add tenant_images table"
```

---

### Task 3: Images repository

**Files:**
- Create: `src/integrations/cloudflare/images-repository.ts`
- Test: `tests/integration/images-repository.test.ts`

**Step 1: Write the failing integration test**

```ts
// tests/integration/images-repository.test.ts
import { describe, expect, it } from 'vitest';
import { insertImage, getImageById, getImagesByTaskId } from '../../src/integrations/cloudflare/images-repository.js';
import { resetDb, seedTenant } from './helpers/db.js';

describe('images repository', () => {
  it('inserts and retrieves by id', async () => {
    await resetDb();
    const tenant = await seedTenant();
    const img = await insertImage({
      tenantId: tenant.id,
      cfImageId: 'cf-abc',
      url: 'https://imagedelivery.net/hash/cf-abc/public',
      sourceType: 'uploaded',
    });
    expect(img.id).toBeDefined();
    const fetched = await getImageById(tenant.id, img.id);
    expect(fetched?.cfImageId).toBe('cf-abc');
  });

  it('returns null for unknown id', async () => {
    await resetDb();
    const tenant = await seedTenant();
    const result = await getImageById(tenant.id, '00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('fetches all images for a task', async () => {
    await resetDb();
    const tenant = await seedTenant();
    // seedTask is a helper we'll use — check tests/integration/helpers/db.ts for
    // existing task creation helpers; if none, insert directly via db.insert(tasks).
    const { db } = await import('../../src/db/client.js');
    const { tasks } = await import('../../src/db/schema/index.js');
    const [task] = await db.insert(tasks).values({
      tenantId: tenant.id, title: 'test', kind: 'execution', status: 'todo', input: {},
    }).returning();
    await insertImage({ tenantId: tenant.id, cfImageId: 'img1', url: 'u1', sourceType: 'generated', taskId: task!.id });
    await insertImage({ tenantId: tenant.id, cfImageId: 'img2', url: 'u2', sourceType: 'generated', taskId: task!.id });
    const imgs = await getImagesByTaskId(tenant.id, task!.id);
    expect(imgs).toHaveLength(2);
  });
});
```

**Step 2: Run — expect fail**
```bash
pnpm test:integration -- tests/integration/images-repository.test.ts
```

**Step 3: Implement**

```ts
// src/integrations/cloudflare/images-repository.ts
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  type NewTenantImage,
  type TenantImage,
  tenantImages,
} from '../../db/schema/index.js';

export async function insertImage(
  input: Omit<NewTenantImage, 'id' | 'createdAt'>,
): Promise<TenantImage> {
  const [row] = await db.insert(tenantImages).values(input).returning();
  if (!row) throw new Error('Failed to insert tenant_image');
  return row;
}

export async function getImageById(
  tenantId: string,
  id: string,
): Promise<TenantImage | null> {
  const [row] = await db
    .select()
    .from(tenantImages)
    .where(and(eq(tenantImages.id, id), eq(tenantImages.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

export async function getImagesByIds(
  tenantId: string,
  ids: string[],
): Promise<TenantImage[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(tenantImages)
    .where(and(eq(tenantImages.tenantId, tenantId)));
  return rows.filter((r) => ids.includes(r.id));
}

export async function getImagesByTaskId(
  tenantId: string,
  taskId: string,
): Promise<TenantImage[]> {
  return db
    .select()
    .from(tenantImages)
    .where(and(eq(tenantImages.tenantId, tenantId), eq(tenantImages.taskId, taskId)));
}
```

**Step 4: Run — expect pass**
```bash
pnpm test:integration -- tests/integration/images-repository.test.ts
```

**Step 5: Commit**
```bash
git add src/integrations/cloudflare/images-repository.ts tests/integration/images-repository.test.ts
git commit -m "feat(images): add tenant_images repository (insert/getById/getByTaskId)"
```

---

## Section B — External clients

### Task 4: `CloudflareImagesClient` (TDD)

**Files:**
- Create: `src/integrations/cloudflare/images-client.ts`
- Test: `tests/cloudflare-images-client.test.ts`

**Step 1: Write the failing test**

```ts
// tests/cloudflare-images-client.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CloudflareImagesClient } from '../src/integrations/cloudflare/images-client.js';

describe('CloudflareImagesClient', () => {
  it('uploads buffer and parses cfImageId + url from response', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          result: {
            id: 'cf-img-123',
            variants: ['https://imagedelivery.net/HASH/cf-img-123/public'],
          },
          success: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new CloudflareImagesClient({
      accountId: 'acct',
      token: 'tok',
      accountHash: 'HASH',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const result = await client.upload(Buffer.from('imgdata'), {
      filename: 'product.jpg',
      mimeType: 'image/jpeg',
    });
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acct/images/v1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
    expect(result.cfImageId).toBe('cf-img-123');
    expect(result.url).toBe('https://imagedelivery.net/HASH/cf-img-123/public');
  });

  it('throws on CF API error', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'quota exceeded' }] }), {
        status: 400,
      }),
    );
    const client = new CloudflareImagesClient({
      accountId: 'a', token: 't', accountHash: 'h',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(
      client.upload(Buffer.from('x'), { filename: 'x.jpg', mimeType: 'image/jpeg' }),
    ).rejects.toThrow(/quota exceeded/);
  });
});
```

**Step 2: Run — expect fail**
```bash
pnpm test -- tests/cloudflare-images-client.test.ts
```

**Step 3: Implement**

```ts
// src/integrations/cloudflare/images-client.ts
import { FormData, Blob } from 'node:buffer';

export interface CloudflareImagesClientOpts {
  accountId: string;
  token: string;
  /** CF Images delivery hash — appears in variant URLs. */
  accountHash: string;
  fetchImpl?: typeof fetch;
}

export class CloudflareImagesClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CloudflareImagesClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async upload(
    buffer: Buffer,
    meta: { filename: string; mimeType: string; metadata?: Record<string, string> },
  ): Promise<{ cfImageId: string; url: string }> {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: meta.mimeType }), meta.filename);
    if (meta.metadata) {
      form.append('metadata', JSON.stringify(meta.metadata));
    }

    const res = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${this.opts.accountId}/images/v1`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.token}` },
        body: form as unknown as BodyInit,
      },
    );

    const json = (await res.json()) as {
      success: boolean;
      errors?: { message: string }[];
      result?: { id: string; variants: string[] };
    };

    if (!json.success || !json.result) {
      const msg = json.errors?.[0]?.message ?? `CF Images upload failed (${res.status})`;
      throw new Error(msg);
    }

    const cfImageId = json.result.id;
    const url = `https://imagedelivery.net/${this.opts.accountHash}/${cfImageId}/public`;
    return { cfImageId, url };
  }
}
```

**Step 4: Run — expect pass**
```bash
pnpm test -- tests/cloudflare-images-client.test.ts
```

**Step 5: Commit**
```bash
git add src/integrations/cloudflare/images-client.ts tests/cloudflare-images-client.test.ts
git commit -m "feat(cloudflare): add CloudflareImagesClient with injectable fetch"
```

---

### Task 5: `OpenAIImagesClient` (TDD)

**Files:**
- Create: `src/integrations/openai-images/client.ts`
- Test: `tests/openai-images-client.test.ts`

**Step 1: Write the failing test**

```ts
// tests/openai-images-client.test.ts
import { describe, expect, it, vi } from 'vitest';
import { OpenAIImagesClient } from '../src/integrations/openai-images/client.js';

const fakeImageB64 = Buffer.from('fakeimage').toString('base64');

describe('OpenAIImagesClient', () => {
  it('generate: POSTs to OpenAI and returns Buffer', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: fakeImageB64 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new OpenAIImagesClient({ apiKey: 'sk-test', fetchImpl: fakeFetch as unknown as typeof fetch });
    const buf = await client.generate({ prompt: 'a linen shirt' });

    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
        body: expect.stringContaining('"model":"gpt-image-1"'),
      }),
    );
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString('base64')).toBe(fakeImageB64);
  });

  it('edit: sends multipart and returns Buffer', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: fakeImageB64 }] }),
        { status: 200 },
      ),
    );
    const client = new OpenAIImagesClient({ apiKey: 'sk-test', fetchImpl: fakeFetch as unknown as typeof fetch });
    const buf = await client.edit({
      imageBuffer: Buffer.from('srcimg'),
      prompt: 'white background',
    });
    expect(buf.toString('base64')).toBe(fakeImageB64);
    const [, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
    // multipart body, not JSON
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('throws on non-2xx', async () => {
    const fakeFetch = vi.fn(async () => new Response('{"error":{"message":"invalid key"}}', { status: 401 }));
    const client = new OpenAIImagesClient({ apiKey: 'bad', fetchImpl: fakeFetch as unknown as typeof fetch });
    await expect(client.generate({ prompt: 'x' })).rejects.toThrow(/invalid key/);
  });
});
```

**Step 2: Run — expect fail**
```bash
pnpm test -- tests/openai-images-client.test.ts
```

**Step 3: Implement**

```ts
// src/integrations/openai-images/client.ts
import { FormData, Blob } from 'node:buffer';

export interface OpenAIImagesClientOpts {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class OpenAIImagesClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAIImagesClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async generate(opts: {
    prompt: string;
    size?: '1024x1024' | '1792x1024' | '1024x1792';
    quality?: 'standard' | 'hd';
  }): Promise<Buffer> {
    const res = await this.fetchImpl('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: opts.prompt,
        n: 1,
        size: opts.size ?? '1024x1024',
        quality: opts.quality ?? 'standard',
        response_format: 'b64_json',
      }),
    });
    return this.parseImageResponse(res);
  }

  async edit(opts: {
    imageBuffer: Buffer;
    prompt: string;
    size?: '1024x1024';
  }): Promise<Buffer> {
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('image', new Blob([opts.imageBuffer], { type: 'image/png' }), 'image.png');
    form.append('prompt', opts.prompt);
    form.append('n', '1');
    form.append('size', opts.size ?? '1024x1024');
    form.append('response_format', 'b64_json');

    const res = await this.fetchImpl('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form as unknown as BodyInit,
    });
    return this.parseImageResponse(res);
  }

  private async parseImageResponse(res: Response): Promise<Buffer> {
    const json = (await res.json()) as {
      data?: { b64_json?: string }[];
      error?: { message: string };
    };
    if (!res.ok || !json.data?.[0]?.b64_json) {
      throw new Error(json.error?.message ?? `OpenAI Images error (${res.status})`);
    }
    return Buffer.from(json.data[0].b64_json, 'base64');
  }
}
```

**Step 4: Run — expect pass**
```bash
pnpm test -- tests/openai-images-client.test.ts
```

**Step 5: Commit**
```bash
git add src/integrations/openai-images/client.ts tests/openai-images-client.test.ts
git commit -m "feat(openai-images): add OpenAIImagesClient (generate + edit)"
```

---

## Section C — Image tools for agents

### Task 6: `buildImageTools` — `images.generate` + `images.edit` (TDD)

**Files:**
- Create: `src/integrations/openai-images/tools.ts`
- Test: `tests/image-tools.test.ts`

**Step 1: Write the failing test**

```ts
// tests/image-tools.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildImageTools } from '../src/integrations/openai-images/tools.js';

describe('buildImageTools', () => {
  const fakeBuffer = Buffer.from('generated');

  it('images.generate: calls openai.generate, uploads to CF, inserts image row, returns id+url', async () => {
    const openai = { generate: vi.fn(async () => fakeBuffer) };
    const cf = { upload: vi.fn(async () => ({ cfImageId: 'cf1', url: 'https://img/cf1/public' })) };
    const insertImage = vi.fn(async (input: unknown) => ({ ...input as object, id: 'img-uuid-1', createdAt: new Date() }));

    const tools = buildImageTools('tenant1', {
      openaiClient: openai as never,
      cfClient: cf as never,
      insertImage: insertImage as never,
      taskId: 'task-1',
    });

    const genTool = tools.find((t) => t.id === 'images.generate');
    expect(genTool).toBeDefined();
    const result = await genTool!.tool.invoke({ prompt: 'product shot' });

    expect(openai.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'product shot' }));
    expect(cf.upload).toHaveBeenCalledWith(fakeBuffer, expect.objectContaining({ mimeType: 'image/png' }));
    expect(insertImage).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant1',
      cfImageId: 'cf1',
      sourceType: 'generated',
      taskId: 'task-1',
    }));
    expect(result).toMatchObject({ id: 'img-uuid-1', url: 'https://img/cf1/public' });
  });

  it('images.edit: downloads source image, edits, uploads, inserts with sourceImageId', async () => {
    const sourceBuffer = Buffer.from('source');
    const openai = { edit: vi.fn(async () => fakeBuffer) };
    const cf = {
      upload: vi.fn(async () => ({ cfImageId: 'cf2', url: 'https://img/cf2/public' })),
    };
    const fetchImage = vi.fn(async () => sourceBuffer);
    const getImageById = vi.fn(async () => ({ id: 'src-id', url: 'https://img/src/public', cfImageId: 'src' }));
    const insertImage = vi.fn(async (input: unknown) => ({ ...input as object, id: 'img-uuid-2', createdAt: new Date() }));

    const tools = buildImageTools('tenant1', {
      openaiClient: openai as never,
      cfClient: cf as never,
      insertImage: insertImage as never,
      getImageById: getImageById as never,
      fetchImageBuffer: fetchImage as never,
    });

    const editTool = tools.find((t) => t.id === 'images.edit');
    await editTool!.tool.invoke({ sourceImageId: 'src-id', prompt: 'white background' });

    expect(getImageById).toHaveBeenCalledWith('tenant1', 'src-id');
    expect(fetchImage).toHaveBeenCalledWith('https://img/src/public');
    expect(openai.edit).toHaveBeenCalledWith(expect.objectContaining({ imageBuffer: sourceBuffer }));
    expect(insertImage).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'edited',
      sourceImageId: 'src-id',
    }));
  });
});
```

**Step 2: Run — expect fail**
```bash
pnpm test -- tests/image-tools.test.ts
```

**Step 3: Implement**

```ts
// src/integrations/openai-images/tools.ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentTool } from '../../agents/types.js';
import type { CloudflareImagesClient } from '../cloudflare/images-client.js';
import type { TenantImage, NewTenantImage } from '../../db/schema/index.js';
import type { OpenAIImagesClient } from './client.js';

export const IMAGE_TOOL_IDS = ['images.generate', 'images.edit'] as const;

export interface BuildImageToolsOpts {
  openaiClient: OpenAIImagesClient;
  cfClient: CloudflareImagesClient;
  insertImage: (input: Omit<NewTenantImage, 'id' | 'createdAt'>) => Promise<TenantImage>;
  getImageById?: (tenantId: string, id: string) => Promise<TenantImage | null>;
  fetchImageBuffer?: (url: string) => Promise<Buffer>;
  taskId?: string;
}

export function buildImageTools(
  tenantId: string,
  opts: BuildImageToolsOpts,
): AgentTool[] {
  const generateTool = tool(
    async (input: { prompt: string; size?: string; quality?: string }) => {
      const buffer = await opts.openaiClient.generate({
        prompt: input.prompt,
        size: (input.size as '1024x1024') ?? '1024x1024',
        quality: (input.quality as 'standard') ?? 'standard',
      });
      const { cfImageId, url } = await opts.cfClient.upload(buffer, {
        filename: 'generated.png',
        mimeType: 'image/png',
      });
      const image = await opts.insertImage({
        tenantId,
        cfImageId,
        url,
        sourceType: 'generated',
        prompt: input.prompt,
        status: 'ready',
        mimeType: 'image/png',
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
      });
      return { id: image.id, url: image.url };
    },
    {
      name: 'images_generate',
      description: 'Generate a new image from a text prompt using AI. Returns the image id and url.',
      schema: z.object({
        prompt: z.string().min(5).describe('Detailed description of the image to generate.'),
        size: z.enum(['1024x1024', '1792x1024', '1024x1792']).optional(),
        quality: z.enum(['standard', 'hd']).optional(),
      }),
    },
  );

  const editTool = tool(
    async (input: { sourceImageId: string; prompt: string }) => {
      if (!opts.getImageById || !opts.fetchImageBuffer) {
        throw new Error('images.edit requires getImageById and fetchImageBuffer');
      }
      const source = await opts.getImageById(tenantId, input.sourceImageId);
      if (!source) throw new Error(`Source image ${input.sourceImageId} not found`);

      const sourceBuffer = await opts.fetchImageBuffer(source.url);
      const buffer = await opts.openaiClient.edit({
        imageBuffer: sourceBuffer,
        prompt: input.prompt,
      });
      const { cfImageId, url } = await opts.cfClient.upload(buffer, {
        filename: 'edited.png',
        mimeType: 'image/png',
      });
      const image = await opts.insertImage({
        tenantId,
        cfImageId,
        url,
        sourceType: 'edited',
        prompt: input.prompt,
        sourceImageId: input.sourceImageId,
        status: 'ready',
        mimeType: 'image/png',
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
      });
      return { id: image.id, url: image.url };
    },
    {
      name: 'images_edit',
      description: 'Edit an existing image using AI. Provide the source image id and a description of the edit.',
      schema: z.object({
        sourceImageId: z.string().uuid().describe('ID of the existing tenant image to edit.'),
        prompt: z.string().min(5).describe('Description of how to edit the image.'),
      }),
    },
  );

  return [
    { id: 'images.generate', tool: generateTool },
    { id: 'images.edit', tool: editTool },
  ];
}
```

**Step 4: Run — expect pass**
```bash
pnpm test -- tests/image-tools.test.ts
```

**Step 5: Commit**
```bash
git add src/integrations/openai-images/tools.ts tests/image-tools.test.ts
git commit -m "feat(openai-images): add buildImageTools (images.generate + images.edit)"
```

---

## Section D — Upload endpoint

### Task 7: `POST /v1/uploads` route (TDD integration)

**Files:**
- Create: `src/api/routes/uploads.ts`
- Modify: `src/api/routes/index.ts`
- Test: `tests/integration/uploads.test.ts`

**Step 1: Write the failing integration test**

```ts
// tests/integration/uploads.test.ts
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { makeAuthHeader, seedTenant, seedUser, resetDb } from './helpers/db.js';
import type { FastifyInstance } from 'fastify';

describe('POST /v1/uploads', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(async () => { await app.close(); });

  it('rejects non-image MIME type', async () => {
    await resetDb();
    const { tenant, token } = await seedTenantWithToken();
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'file.txt');

    const res = await app.inject({
      method: 'POST', url: '/v1/uploads',
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenant.id },
      payload: form as unknown,
    });
    expect(res.statusCode).toBe(400);
  });

  it('uploads image, inserts tenant_images row, returns id+url', async () => {
    await resetDb();
    const { tenant, token } = await seedTenantWithToken();

    // Stub CF Images fetch so we don't hit network
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          result: { id: 'cf-test', variants: ['https://imagedelivery.net/HASH/cf-test/public'] },
          success: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fakeFetch);

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('imgdata')], { type: 'image/jpeg' }), 'product.jpg');

    const res = await app.inject({
      method: 'POST', url: '/v1/uploads',
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenant.id },
      payload: form as unknown,
    });

    vi.unstubAllGlobals();
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; url: string }>();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toContain('imagedelivery.net');
  });
});

// Helper — adapt to your existing auth seeding pattern in helpers/auth.ts
async function seedTenantWithToken() {
  const { createTestToken, seedTenant, seedUser, addMember } = await import('./helpers/db.js');
  // Look at existing integration tests (e.g. lifecycle.test.ts) for the exact
  // auth token seeding pattern used in this project.
  throw new Error('TODO: implement using the project\'s existing auth helper pattern');
}
```

> **Note:** The `seedTenantWithToken` helper is a placeholder — look at `tests/integration/lifecycle.test.ts` for the exact pattern used to mint JWT tokens and seed tenant membership. Copy that pattern here.

**Step 2: Run — expect fail**
```bash
pnpm test:integration -- tests/integration/uploads.test.ts
```

**Step 3: Implement the route**

```ts
// src/api/routes/uploads.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CloudflareImagesClient } from '../../integrations/cloudflare/images-client.js';
import { insertImage } from '../../integrations/cloudflare/images-repository.js';
import { env } from '../../config/env.js';
import { ValidationError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, tenantOf } from '../middleware/tenant.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.post('/uploads', { schema: { tags: ['uploads'] } }, async (req) => {
    const tenantId = tenantOf(req);

    const data = await req.file({ limits: { fileSize: MAX_BYTES } });
    if (!data) throw new ValidationError('No file uploaded', {});

    const mimeType = data.mimetype;
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new ValidationError(`Unsupported MIME type: ${mimeType}. Allowed: jpeg, png, webp, gif`, {});
    }

    const buffer = await data.toBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      throw new ValidationError('File exceeds 10 MB limit', {});
    }

    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const token = env.CLOUDFLARE_IMAGES_TOKEN;
    const accountHash = env.CLOUDFLARE_IMAGES_HASH;
    if (!accountId || !token || !accountHash) {
      throw new Error('Cloudflare Images is not configured (missing env vars)');
    }

    const cf = new CloudflareImagesClient({ accountId, token, accountHash });
    const { cfImageId, url } = await cf.upload(buffer, {
      filename: data.filename ?? 'upload',
      mimeType,
      metadata: { tenantId },
    });

    const image = await insertImage({
      tenantId,
      cfImageId,
      url,
      sourceType: 'uploaded',
      status: 'ready',
      mimeType,
      fileSize: buffer.byteLength,
    });

    return { id: image.id, url: image.url };
  });
}
```

You'll also need `@fastify/multipart` for `req.file()`. Check if it's already in `package.json`; if not:
```bash
pnpm add @fastify/multipart
```
Then register it in `src/server.ts` (find where other plugins like `@fastify/swagger` are registered and add):
```ts
import multipart from '@fastify/multipart';
await app.register(multipart);
```

**Step 4: Register route in `src/api/routes/index.ts`**

```ts
import { uploadRoutes } from './uploads.js';
// inside registerRoutes:
await app.register(uploadRoutes, { prefix: '/v1' });
```

**Step 5: Run — fix the seedTenantWithToken TODO, then expect pass**
```bash
pnpm test:integration -- tests/integration/uploads.test.ts
```

**Step 6: Commit**
```bash
git add src/api/routes/uploads.ts src/api/routes/index.ts tests/integration/uploads.test.ts src/server.ts
git commit -m "feat(api): add POST /v1/uploads with CF Images proxy"
```

---

## Section E — Type updates & vision

### Task 8: Extend types for imageIds

**Files:**
- Modify: `src/db/schema/messages.ts`
- Modify: `src/db/schema/intakes.ts`
- Modify: `src/tasks/output.ts`
- Modify: `src/agents/types.ts`
- Modify: `src/orchestrator/state.ts`

**Step 1: `messages.data` type**

In `src/db/schema/messages.ts`, change the `data` field's `$type`:
```ts
data: jsonb('data').$type<{ imageIds?: string[]; [key: string]: unknown }>(),
```

**Step 2: `IntakeMessage` type**

In `src/db/schema/intakes.ts`, add `imageIds` to the type:
```ts
export type IntakeMessage = {
  role: IntakeMessageRole;
  content: string;
  createdAt: string;
  imageIds?: string[];
};
```

**Step 3: `TaskOutput`**

In `src/tasks/output.ts`, add:
```ts
generatedImageIds?: string[];
```

**Step 4: `AgentInput.messages`**

In `src/agents/types.ts`, line 136, change:
```ts
messages: { role: 'user' | 'assistant' | 'system' | 'tool'; content: string; imageIds?: string[] }[];
```

**Step 5: `GraphState`**

In `src/orchestrator/state.ts`, read the current file and add `taskImageIds` to the state annotation. It should hold all image IDs attached to any message in this task (a flat list, collected from DB messages when the task is seeded):

```ts
taskImageIds: Annotation<string[] | null>({
  reducer: (_prev, next) => next,
  default: () => null,
}),
```

**Step 6: Typecheck**
```bash
pnpm typecheck
```
Fix any type errors that arise from the `AgentInput.messages` change (graph.ts maps the messages and will need `imageIds` passed through).

**Step 7: Commit**
```bash
git add src/db/schema/messages.ts src/db/schema/intakes.ts src/tasks/output.ts src/agents/types.ts src/orchestrator/state.ts
git commit -m "feat(types): add imageIds to messages, intakes, TaskOutput, AgentInput, GraphState"
```

---

### Task 9: `buildAgentMessages` → async + vision (TDD)

**Files:**
- Modify: `src/agents/lib/messages.ts`
- Modify: `tests/agents-lib.test.ts` (create if not exists; check `tests/` for existing lib tests)

**Step 1: Write the failing test**

```ts
// tests/agents-lib-messages.test.ts
import { describe, expect, it } from 'vitest';
import { buildAgentMessages } from '../src/agents/lib/messages.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

describe('buildAgentMessages — vision', () => {
  it('injects image_url blocks for messages with imageIds', async () => {
    const resolver = async (ids: string[]) => ids.map((id) => `https://img/${id}/public`);
    const history = [
      { role: 'user' as const, content: 'look at this product', imageIds: ['uuid-1'] },
    ];
    const msgs = await buildAgentMessages('System prompt', history, [], resolver);

    const human = msgs[1] as HumanMessage;
    expect(Array.isArray(human.content)).toBe(true);
    const parts = human.content as { type: string }[];
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
    expect(parts.some((p) => p.type === 'text')).toBe(true);
  });

  it('plain text when no imageIds', async () => {
    const history = [{ role: 'user' as const, content: 'hello' }];
    const msgs = await buildAgentMessages('sys', history);
    const human = msgs[1] as HumanMessage;
    expect(typeof human.content).toBe('string');
  });

  it('plain text when no resolver provided', async () => {
    const history = [{ role: 'user' as const, content: 'hi', imageIds: ['x'] }];
    const msgs = await buildAgentMessages('sys', history);
    const human = msgs[1] as HumanMessage;
    expect(typeof human.content).toBe('string');
  });
});
```

**Step 2: Run — expect fail**
```bash
pnpm test -- tests/agents-lib-messages.test.ts
```

**Step 3: Update `buildAgentMessages`**

```ts
// src/agents/lib/messages.ts
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentInput } from '../types.js';

type ImageResolver = (imageIds: string[]) => Promise<string[]>;

export async function buildAgentMessages(
  systemPrompt: string,
  history: AgentInput['messages'],
  constraints?: readonly string[],
  imageResolver?: ImageResolver,
): Promise<BaseMessage[]> {
  const system =
    constraints && constraints.length > 0
      ? `${systemPrompt}\n\nTenant constraints:\n- ${constraints.join('\n- ')}`
      : systemPrompt;

  const historyMessages = await Promise.all(
    history.map(async (m) => {
      const hasImages = imageResolver && m.imageIds && m.imageIds.length > 0;
      if (m.role === 'assistant') return new AIMessage(m.content);
      if (!hasImages) return new HumanMessage(m.content);

      const urls = await imageResolver!(m.imageIds!);
      const content: { type: string; image_url?: { url: string }; text?: string }[] = [
        ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
        { type: 'text', text: m.content },
      ];
      return new HumanMessage({ content });
    }),
  );

  return [new SystemMessage(system), ...historyMessages];
}
```

**Important:** `buildAgentMessages` is now `async`. Update all callers — the three agent files (`shopify-ops`, `shopify-blog-writer`, `seo-strategist`) that call it synchronously need to `await` it now.

**Step 4: Update callers**

In each agent's `invoke()`, change:
```ts
const messages = buildAgentMessages(...);
// →
const messages = await buildAgentMessages(...);
```

**Step 5: Run all tests — expect pass**
```bash
pnpm test
```

**Step 6: Commit**
```bash
git add src/agents/lib/messages.ts tests/agents-lib-messages.test.ts src/agents/builtin/
git commit -m "feat(agents): buildAgentMessages async + vision image_url blocks"
```

---

### Task 10: Propagate `taskImageIds` through runner + graph

**Files:**
- Modify: `src/tasks/runner.ts`
- Modify: `src/orchestrator/graph.ts`

**Step 1: `runner.ts` — collect imageIds when seeding initial state**

In `runTaskThroughGraph`, after `const history = await listMessages(...)` (both fresh and resumed paths), collect imageIds:

```ts
const taskImageIds = history
  .flatMap((m) => (m.data as { imageIds?: string[] } | null)?.imageIds ?? []);
```

Then include in `invokeInput`:
```ts
invokeInput = initialState({
  tenantId: task.tenantId,
  taskId: task.id,
  brief,
  params: ...,
  pinnedAgent: task.assignedAgent,
  taskImageIds: taskImageIds.length > 0 ? taskImageIds : null,
});
```

Update `initialState()` in `graph.ts` to accept and pass `taskImageIds`:
```ts
export function initialState(input: {
  ...
  taskImageIds?: string[] | null;
}): Partial<GraphState> {
  return {
    ...
    taskImageIds: input.taskImageIds ?? null,
  };
}
```

For resumed runs, also pass `taskImageIds` in the update:
```ts
invokeInput = latestUser
  ? { messages: [new HumanMessage(latestUser.content)], taskImageIds: taskImageIds.length > 0 ? taskImageIds : null }
  : null;
```

**Step 2: `graph.ts` — pass imageResolver to agent nodes**

In the agent node (around line 82), before calling `runnable.invoke(...)`, create an imageResolver:

```ts
import { getImagesByIds } from '../integrations/cloudflare/images-repository.js';

const imageResolver = state.taskImageIds?.length
  ? async (ids: string[]) => {
      const imgs = await getImagesByIds(opts.tenantId, ids);
      return imgs.map((i) => i.url);
    }
  : undefined;
```

Then update the `messages` mapping to include `imageIds` and pass the resolver:

```ts
const agentMessages = state.messages.map((m, idx) => ({
  role: m.getType() === 'human' ? 'user' : m.getType() === 'ai' ? 'assistant' : 'system',
  content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  imageIds: state.taskImageIds
    ? /* attach all task imageIds to the first human message only */ idx === 0
      ? state.taskImageIds
      : undefined
    : undefined,
})) as AgentInput['messages'];
```

> **Note:** For v1, attaching all task imageIds to the first message is a reasonable simplification. The agent sees all uploaded images for the task. Per-message imageIds tracking can be refined later.

Pass `imageResolver` to `runnable.invoke`:
```ts
const result = await runnable.invoke({
  messages: agentMessages,
  params: state.params,
  taskOutput: state.currentTaskOutput ?? undefined,
  imageResolver,
});
```

Update `AgentInput` to include `imageResolver?`:
```ts
// src/agents/types.ts
export interface AgentInput {
  messages: { role: ...; content: string; imageIds?: string[] }[];
  params: Record<string, unknown>;
  taskOutput?: Record<string, unknown>;
  imageResolver?: (imageIds: string[]) => Promise<string[]>;
}
```

And in each agent's `invoke()`, pass `input.imageResolver` to `buildAgentMessages`.

**Step 3: Typecheck**
```bash
pnpm typecheck
```

**Step 4: Run tests**
```bash
pnpm test:all
```

**Step 5: Commit**
```bash
git add src/tasks/runner.ts src/orchestrator/graph.ts src/agents/types.ts src/agents/builtin/
git commit -m "feat(vision): propagate taskImageIds through GraphState and buildAgentMessages"
```

---

## Section F — Shopify Ops agent

### Task 11: Wire image tools + config into shopify-ops

**Files:**
- Modify: `src/agents/builtin/shopify-ops/index.ts`

**Step 1: Add `images` to `configSchema`**

```ts
images: z
  .object({
    autoGenerate: z.boolean().default(true).describe(
      'If true, agent generates product images when none are in the task',
    ),
    style: z.string().nullish().describe(
      'Image style hint, e.g. "clean white background, product photography"',
    ),
  })
  .default({}),
```

**Step 2: In `build()`, instantiate clients + tools**

```ts
import { CloudflareImagesClient } from '../../../integrations/cloudflare/images-client.js';
import { OpenAIImagesClient } from '../../../integrations/openai-images/client.js';
import { buildImageTools } from '../../../integrations/openai-images/tools.js';
import { insertImage, getImageById } from '../../../integrations/cloudflare/images-repository.js';

// inside build():
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const cfToken = env.CLOUDFLARE_IMAGES_TOKEN;
const accountHash = env.CLOUDFLARE_IMAGES_HASH;
const openaiKey = env.OPENAI_API_KEY;

const imageTools =
  accountId && cfToken && accountHash && openaiKey
    ? buildImageTools(ctx.tenantId, {
        openaiClient: new OpenAIImagesClient({ apiKey: openaiKey }),
        cfClient: new CloudflareImagesClient({ accountId, token: cfToken, accountHash }),
        insertImage,
        getImageById,
        fetchImageBuffer: async (url) => {
          const res = await fetch(url);
          return Buffer.from(await res.arrayBuffer());
        },
        taskId: ctx.taskId,
      })
    : [];
```

**Step 3: Update `manifest.toolIds`**
```ts
toolIds: [...SHOPIFY_TOOL_IDS, ...IMAGE_TOOL_IDS],
```

**Step 4: Update returned `tools`**

```ts
return { tools: [...filteredTools, ...imageTools], invoke };
```

**Step 5: Update `invoke()` to handle images**

Before calling `model.invoke(messages)`, check for task imageIds in input params and conditionally generate images. After getting the `listing` from the LLM:

```ts
// Resolve images: use uploaded ones if boss provided them, else generate if configured
let imageIds: string[] = [];
const inputImageIds = (input.params as { imageIds?: string[] }).imageIds ?? [];

if (inputImageIds.length > 0) {
  // Boss uploaded images — use as-is (or edit if prompt suggests modification)
  imageIds = inputImageIds;
} else if (cfg.images.autoGenerate && imageTools.length > 0) {
  const genTool = imageTools.find((t) => t.id === 'images.generate');
  if (genTool) {
    const styleHint = cfg.images.style ?? 'clean white background, product photography';
    const imgResult = await genTool.tool.invoke({
      prompt: `${listing.title}. ${styleHint}`,
    }) as { id: string; url: string };
    imageIds = [imgResult.id];
  }
}
```

Then update `pendingToolCall.args` to include resolved image URLs:
```ts
// Resolve UUIDs to URLs for Shopify (Shopify needs URLs not internal IDs)
const imageUrls = imageIds.length > 0 && input.imageResolver
  ? await input.imageResolver(imageIds)
  : [];

const pendingToolCall = {
  id: 'shopify.create_product',
  args: {
    title: listing.title,
    bodyHtml: listing.bodyHtml,
    tags: listing.tags,
    vendor: listing.vendor,
    ...(imageUrls.length > 0 ? { images: imageUrls.map((url) => ({ url })) } : {}),
  },
};
```

**Step 6: Typecheck + unit tests**
```bash
pnpm typecheck && pnpm test -- tests/shopify-ops.test.ts
```

**Step 7: Commit**
```bash
git add src/agents/builtin/shopify-ops/index.ts
git commit -m "feat(shopify-ops): wire image generation tools and auto-generate product images"
```

---

### Task 12: Update `shopify.create_product` tool to accept images

**Files:**
- Modify: `src/integrations/shopify/tools.ts`
- Modify: `src/integrations/shopify/client.ts`

**Step 1: Add `images` parameter to the `create_product` tool schema**

In `tools.ts`, find the `createProduct` tool schema and add:
```ts
images: z.array(z.object({ url: z.string().url() })).optional()
  .describe('Optional product images. Each entry has a url pointing to an accessible image.'),
```

**Step 2: Pass images through to the Shopify API call**

In the tool's handler, forward `input.images` to the client:
```ts
const result = await client.createProduct({
  ...existingFields,
  images: input.images,
});
```

**Step 3: Update `ShopifyAdminClient.createProduct`** in `client.ts` to include images in the Shopify product POST body:

```ts
// In the product body object:
...(images?.length ? { images: images.map((img) => ({ src: img.url })) } : {}),
```

(Shopify Admin REST `POST /products.json` accepts `product.images[].src`.)

**Step 4: Run all tests**
```bash
pnpm test:all
```

**Step 5: Commit**
```bash
git add src/integrations/shopify/tools.ts src/integrations/shopify/client.ts
git commit -m "feat(shopify): create_product tool accepts images array"
```

---

## Section G — Blog Writer agent

### Task 13: Blog Writer — `generateCoverImage` config + cover image in Stage 2

**Files:**
- Modify: `src/agents/builtin/shopify-blog-writer/index.ts`

**Step 1: Add config fields**

```ts
generateCoverImage: z.boolean().default(true).describe(
  'If true, agent generates a cover image for the article before approval.',
),
coverImageStyle: z.string().nullish().describe(
  'Style hint for the cover image, e.g. "editorial, warm tones".',
),
```

**Step 2: In `build()`, instantiate image tools** (same pattern as shopify-ops Task 11 Step 2).

**Step 3: In Stage 2 `invoke()`, after getting `article`, generate cover image**

```ts
// After: const article = (await model.invoke(messages)) as ArticleDraft;
let coverImageUrl: string | undefined;
if (cfg.generateCoverImage && imageTools.length > 0) {
  const genTool = imageTools.find((t) => t.id === 'images.generate');
  if (genTool) {
    const style = cfg.coverImageStyle ?? 'editorial blog cover, clean layout';
    const imgResult = await genTool.tool.invoke({
      prompt: `Blog cover image for: "${article.title}". ${style}`,
    }) as { id: string; url: string };
    coverImageUrl = imgResult.url;
  }
}
```

**Step 4: Include `coverImageUrl` in `pendingToolCall.args`**

```ts
if (cfg.publishToShopify) {
  result.pendingToolCall = {
    id: 'shopify.publish_article',
    args: {
      title: article.title,
      bodyHtml: article.bodyHtml,
      summaryHtml: article.summaryHtml,
      tags: article.tags,
      ...(article.author ? { author: article.author } : {}),
      ...(coverImageUrl ? { coverImageUrl } : {}),
    },
  };
}
```

**Step 5: Unit test**

Update `tests/shopify-ops.test.ts` (or add blog-writer test) to script the image mock. The existing `tests/integration/shopify-blog-writer.test.ts` integration test will need the image generation tool call mocked — see Task 17 for the integration test.

**Step 6: Typecheck + tests**
```bash
pnpm typecheck && pnpm test -- tests/integration/shopify-blog-writer.test.ts
```

**Step 7: Commit**
```bash
git add src/agents/builtin/shopify-blog-writer/index.ts
git commit -m "feat(blog-writer): generate cover image in Stage 2 when generateCoverImage=true"
```

---

### Task 14: Update `shopify.publish_article` tool to accept `coverImageUrl`

**Files:**
- Modify: `src/integrations/shopify/tools.ts`
- Modify: `src/integrations/shopify/client.ts`

**Step 1: Add `coverImageUrl` parameter** to the `publish_article` tool schema:
```ts
coverImageUrl: z.string().url().optional()
  .describe('Optional cover image URL. Attached as the article image in Shopify.'),
```

**Step 2: Forward to Shopify Admin API** in the article body:
```ts
...(coverImageUrl ? { image: { src: coverImageUrl } } : {}),
```

(Shopify Blog Articles API: `article.image.src`.)

**Step 3: Run all tests**
```bash
pnpm test:all
```

**Step 4: Commit**
```bash
git add src/integrations/shopify/tools.ts src/integrations/shopify/client.ts
git commit -m "feat(shopify): publish_article tool accepts coverImageUrl"
```

---

## Section H — Integration tests

### Task 15: Integration test — upload + vision round-trip

**Files:**
- Modify: `tests/integration/uploads.test.ts` (extend from Task 7)

Add a test that verifies: after uploading, the returned `id` can be passed in `tasks.input.imageIds`, and a task run will call `getImagesByIds` and resolve URLs. This can be a lighter test that just verifies the DB state, not a full agent run.

```ts
it('uploaded image id resolves to correct url', async () => {
  // ... (use the happy path from Task 7, capture the returned id)
  // Then verify tenant_images row has correct data
  const { db } = await import('../../src/db/client.js');
  const { tenantImages } = await import('../../src/db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(tenantImages).where(eq(tenantImages.cfImageId, 'cf-test'));
  expect(rows[0]?.sourceType).toBe('uploaded');
  expect(rows[0]?.url).toContain('imagedelivery.net');
});
```

**Run + Commit**
```bash
pnpm test:integration -- tests/integration/uploads.test.ts
git add tests/integration/uploads.test.ts
git commit -m "test(integration): extend upload test with DB assertion"
```

---

### Task 16: Integration test — shopify-ops with image generation

**Files:**
- Modify: `tests/integration/shopify-ops.test.ts`

Add a test variant where:
1. Task is created with `cfg.images.autoGenerate=true`
2. OpenAI + CF image fetch are stubbed
3. Assert `pendingToolCall.args.images` is populated after the agent runs

Use the same LLM mock (`scriptStructured`) for the listing. Stub `globalThis.fetch` to handle both the OpenAI images endpoint and the CF upload endpoint.

```bash
pnpm test:integration -- tests/integration/shopify-ops.test.ts
git add tests/integration/shopify-ops.test.ts
git commit -m "test(integration): shopify-ops generates product images on approve"
```

---

### Task 17: Integration test — blog-writer with cover image

**Files:**
- Modify: `tests/integration/shopify-blog-writer.test.ts`

Add a test that goes through full Stage 1 (EEAT Q&A) → Stage 2 (draft + cover image generation) → approve → publish, asserting `pendingToolCall.args.coverImageUrl` is set in Stage 2.

```bash
pnpm test:integration -- tests/integration/shopify-blog-writer.test.ts
git add tests/integration/shopify-blog-writer.test.ts
git commit -m "test(integration): blog-writer generates cover image in Stage 2"
```

---

### Task 18: Final verification

```bash
pnpm typecheck
pnpm lint
pnpm test:all
```

All checks green. Fix any issues in-place.

```bash
git add -A
git commit -m "fix: final typecheck + lint cleanup for image integration"
```

---

## Skills the executor should reference

- `@superpowers:test-driven-development` — Tasks 4, 5, 6, 7, 9
- `@superpowers:systematic-debugging` — if integration tests fail on CF/OpenAI stub matching
- `@superpowers:verification-before-completion` — at Task 18

## Risks to watch

- **`buildAgentMessages` async change cascades**: all three agent `invoke()` functions call it — every call needs `await`. Check `seo-strategist` two-pass loop too.
- **`FormData` / `Blob` in Node.js**: Use `import { FormData, Blob } from 'node:buffer'` not the global for Node 18+ compatibility. Check the Serper client for the existing pattern.
- **CF Images `accountHash` vs `accountId`**: These are different values. The hash is the short string in delivery URLs. Confirm by making one test upload to real CF and reading the response.
- **Shopify product images API**: Shopify requires `images[].src` to be publicly accessible URLs. CF Images `/public` variant is publicly accessible by default — confirm this is the case for the tenant's CF Images account.
- **Vision model compatibility**: `image_url` content blocks require an OpenRouter model that supports vision (Claude Sonnet/Opus, GPT-4o). If a tenant's agent config uses a non-vision model, `buildAgentMessages` will silently pass image blocks the model can't read. Add a note in `AgentBuildContext` docs but don't enforce at runtime for v1.
