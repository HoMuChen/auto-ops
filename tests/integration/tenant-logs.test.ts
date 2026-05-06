import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';

const { createTestApp } = await import('./helpers/app.js');
const { appendTaskLog, createTask } = await import('../../src/tasks/repository.js');

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll();
});

describe('GET /v1/logs — limit semantics', () => {
  it('returns the LATEST N logs (not the oldest) when no since is provided', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });
    const task = await createTask({ tenantId, title: 'log target', createdBy: userId });

    // Seed 10 logs in order; sleep just enough for distinct timestamps.
    for (let i = 0; i < 10; i++) {
      await appendTaskLog({
        tenantId,
        taskId: task.id,
        event: 'test.tick',
        message: `entry-${i}`,
      });
      await new Promise((r) => setTimeout(r, 5));
    }

    const res = await app.inject({
      method: 'GET',
      url: '/v1/logs?limit=3',
      headers: authHeaders(jwt, tenantId),
    });
    expect(res.statusCode).toBe(200);
    const logs = res.json() as { message: string }[];
    expect(logs).toHaveLength(3);
    // Should be the LAST three (entry-7, entry-8, entry-9), in chronological order.
    expect(logs.map((l) => l.message)).toEqual(['entry-7', 'entry-8', 'entry-9']);
  });

  it('with since= preserves oldest-first chronological order (SSE bootstrap path)', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });
    const task = await createTask({ tenantId, title: 'log target', createdBy: userId });

    const before = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      await appendTaskLog({
        tenantId,
        taskId: task.id,
        event: 'test.tick',
        message: `entry-${i}`,
      });
      await new Promise((r) => setTimeout(r, 5));
    }

    const res = await app.inject({
      method: 'GET',
      url: `/v1/logs?since=${encodeURIComponent(before)}`,
      headers: authHeaders(jwt, tenantId),
    });
    expect(res.statusCode).toBe(200);
    const logs = res.json() as { message: string }[];
    expect(logs.map((l) => l.message)).toEqual([
      'entry-0',
      'entry-1',
      'entry-2',
      'entry-3',
      'entry-4',
    ]);
  });
});
