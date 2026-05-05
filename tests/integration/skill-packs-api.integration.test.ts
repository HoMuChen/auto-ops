import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';

const { createTestApp } = await import('./helpers/app.js');

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: string;
let headers: Record<string, string>;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll();
  const seed = await seedTenantWithOwner();
  tenantId = seed.tenantId;
  const token = await mintJwt({ userId: seed.userId, email: seed.email });
  headers = authHeaders(token, tenantId);
});

const validPack = {
  key: 'tenant.test-pack',
  name: 'Test Pack',
  body: 'You are a helpful assistant.',
  appliesTo: [],
};

describe('POST /v1/skill-packs', () => {
  it('creates a pack and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: validPack,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.key).toBe(validPack.key);
    expect(body.name).toBe(validPack.name);
    expect(body.body).toBe(validPack.body);
    expect(body.appliesTo).toEqual([]);
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  it('rejects key not matching tenant. prefix → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: { ...validPack, key: 'global.something' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate key → 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: validPack,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: validPack,
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects body > 64KB → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: { ...validPack, body: 'x'.repeat(64 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects appliesTo with unknown agent id → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: { ...validPack, appliesTo: ['not-a-real-agent-id'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/skill-packs', () => {
  it('lists created packs', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: validPack,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skill-packs',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe(validPack.key);
  });

  it('returns empty array when no packs exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skill-packs',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('GET /v1/skill-packs/:packId', () => {
  it('returns a single pack by id', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: validPack,
    });
    const { id } = created.json();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/skill-packs/${id}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    expect(res.json().key).toBe(validPack.key);
  });

  it('returns 404 for unknown packId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skill-packs/00000000-0000-0000-0000-000000000000',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /v1/skill-packs/:packId', () => {
  it('updates fields and returns updated pack', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: validPack,
    });
    const { id } = created.json();

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/skill-packs/${id}`,
      headers,
      payload: { name: 'Updated Name', body: 'Updated body text.' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id);
    expect(body.name).toBe('Updated Name');
    expect(body.body).toBe('Updated body text.');
    expect(body.key).toBe(validPack.key); // key unchanged
  });

  it('returns 404 when pack does not exist', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/skill-packs/00000000-0000-0000-0000-000000000000',
      headers,
      payload: { name: 'Whatever' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/skill-packs/:packId', () => {
  it('removes the pack and returns 204', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: validPack,
    });
    const { id } = created.json();

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/skill-packs/${id}`,
      headers,
    });
    expect(del.statusCode).toBe(204);

    // Confirm it's gone
    const get = await app.inject({
      method: 'GET',
      url: `/v1/skill-packs/${id}`,
      headers,
    });
    expect(get.statusCode).toBe(404);
  });

  it('returns 404 when pack does not exist', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/skill-packs/00000000-0000-0000-0000-000000000000',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Tenant isolation', () => {
  it('cannot see packs from another tenant', async () => {
    // Create a pack under tenant 1
    await app.inject({
      method: 'POST',
      url: '/v1/skill-packs',
      headers,
      payload: validPack,
    });

    // Authenticate as tenant 2
    const seed2 = await seedTenantWithOwner();
    const token2 = await mintJwt({ userId: seed2.userId, email: seed2.email });
    const headers2 = authHeaders(token2, seed2.tenantId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/skill-packs',
      headers: headers2,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });
});
