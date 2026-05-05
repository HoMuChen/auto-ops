import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';

const { createTestApp } = await import('./helpers/app.js');

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: string;
let headers: Record<string, string>;

beforeAll(async () => {
  app = await createTestApp();
  const seed = await seedTenantWithOwner();
  tenantId = seed.tenantId;
  const token = await mintJwt({ userId: seed.userId, email: seed.email });
  headers = authHeaders(token, tenantId);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll();
  // Re-seed after truncate since beforeAll runs once
  const seed = await seedTenantWithOwner();
  tenantId = seed.tenantId;
  const token = await mintJwt({ userId: seed.userId, email: seed.email });
  headers = authHeaders(token, tenantId);
});

describe('GET /v1/profile', () => {
  it('returns defaults for a fresh tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/profile',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profileMd: '', timezone: 'UTC' });
  });
});

describe('PUT /v1/profile', () => {
  it('updates and round-trips', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers,
      payload: { profileMd: '# Voice\n\nWarm.', timezone: 'Asia/Taipei' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ profileMd: '# Voice\n\nWarm.', timezone: 'Asia/Taipei' });
  });

  it('rejects oversize profileMd (32KB cap)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers,
      payload: { profileMd: 'x'.repeat(32 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid timezone', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers,
      payload: { timezone: 'Asia/Atlantis' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('IDOR prevention', () => {
  it('cannot read another tenant profile via URL manipulation (IDOR)', async () => {
    // Create a second tenant and write a secret profile directly to DB
    const seed2 = await seedTenantWithOwner();
    const { db } = await import('../../src/db/client.js');
    const { tenants } = await import('../../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await db
      .update(tenants)
      .set({ profileMd: 'secret profile' })
      .where(eq(tenants.id, seed2.tenantId));

    // Authenticated as tenant 1 — tenantOf(req) resolves to tenantId (tenant 1)
    // There is no path param to manipulate; the endpoint is /v1/profile
    const res = await app.inject({
      method: 'GET',
      url: '/v1/profile',
      headers, // x-tenant-id = tenantId (tenant 1)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profileMd).not.toBe('secret profile'); // tenant 2's data must not leak
  });
});
