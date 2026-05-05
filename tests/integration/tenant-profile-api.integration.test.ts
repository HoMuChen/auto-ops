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

describe('GET /v1/tenants/:id/profile', () => {
  it('returns defaults for a fresh tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/profile`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profileMd: '', timezone: 'UTC' });
  });
});

describe('PUT /v1/tenants/:id/profile', () => {
  it('updates and round-trips', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/profile`,
      headers,
      payload: { profileMd: '# Voice\n\nWarm.', timezone: 'Asia/Taipei' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ profileMd: '# Voice\n\nWarm.', timezone: 'Asia/Taipei' });
  });

  it('rejects oversize profileMd (32KB cap)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/profile`,
      headers,
      payload: { profileMd: 'x'.repeat(32 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid timezone', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/profile`,
      headers,
      payload: { timezone: 'Asia/Atlantis' },
    });
    expect(res.statusCode).toBe(400);
  });
});
