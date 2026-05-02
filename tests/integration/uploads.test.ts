import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';

vi.mock('../../src/llm/model-registry.js', async () => {
  const { llmMockModule } = await import('./helpers/llm-mock.js');
  return llmMockModule();
});

const { createTestApp } = await import('./helpers/app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll();
  vi.unstubAllGlobals();
});

async function seedTenantWithToken() {
  const { tenantId, userId, email } = await seedTenantWithOwner();
  const token = await mintJwt({ userId, email });
  return { tenantId, token };
}

describe('POST /v1/uploads', () => {
  it('rejects non-image MIME type', async () => {
    const { tenantId, token } = await seedTenantWithToken();

    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'file.txt');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: authHeaders(token, tenantId),
      payload: form as never,
    });
    expect(res.statusCode).toBe(400);
  });

  it('uploads image, inserts tenant_images row, returns id+url', async () => {
    const { tenantId, token } = await seedTenantWithToken();

    const fakeFetch = vi.fn(
      async () =>
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
      method: 'POST',
      url: '/v1/uploads',
      headers: authHeaders(token, tenantId),
      payload: form as never,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; url: string }>();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toContain('imagedelivery.net');
  });

  it('uploaded image id resolves to correct url', async () => {
    const { tenantId, token } = await seedTenantWithToken();

    const fakeFetch = vi.fn(
      async () =>
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

    await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: authHeaders(token, tenantId),
      payload: form as never,
    });

    const { db } = await import('../../src/db/client.js');
    const { tenantImages } = await import('../../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(tenantImages).where(eq(tenantImages.cfImageId, 'cf-test'));
    expect(rows[0]?.sourceType).toBe('uploaded');
    expect(rows[0]?.url).toContain('imagedelivery.net');
  });
});
