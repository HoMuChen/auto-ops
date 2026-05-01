import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import { clearScript, llmMockModule, scriptStructured } from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

const { createTestApp } = await import('./helpers/app.js');

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
});

describe('Multi-tenant isolation', () => {
  it("Tenant B cannot read or stream Tenant A's task", async () => {
    // Two independent tenants, each with their own owner.
    const a = await seedTenantWithOwner({ slug: 'tenant-a' });
    const b = await seedTenantWithOwner({ slug: 'tenant-b' });
    const jwtA = await mintJwt({ userId: a.userId, email: a.email });
    const jwtB = await mintJwt({ userId: b.userId, email: b.email });

    // Tenant A creates a task and lets it advance to waiting.
    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptStructured({
      title: 'A-only secret content',
      bodyHtml: '<p>Confidential body for tenant A only.</p>',
      summaryHtml: 'Confidential summary for tenant A.',
      tags: ['confidential'],
      language: 'zh-TW',
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authHeaders(jwtA, a.tenantId),
      payload: { brief: 'A confidential brief' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    // Tenant A can read its own task.
    const ownerRead = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: authHeaders(jwtA, a.tenantId),
    });
    expect(ownerRead.statusCode).toBe(200);

    // Tenant B authenticates with its own membership but probes A's task id.
    const fromB = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: authHeaders(jwtB, b.tenantId),
    });
    expect(fromB.statusCode).toBe(404);
    expect(fromB.json().error.code).toBe('not_found');

    // Same for messages and logs — they're scoped by tenantId in the repo.
    const msgsB = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/messages`,
      headers: authHeaders(jwtB, b.tenantId),
    });
    expect(msgsB.statusCode).toBe(200);
    expect(msgsB.json()).toEqual([]);

    const logsB = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/logs`,
      headers: authHeaders(jwtB, b.tenantId),
    });
    expect(logsB.statusCode).toBe(200);
    expect(logsB.json()).toEqual([]);

    // Mutating endpoints should also reject.
    const approveAttempt = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwtB, b.tenantId),
      payload: { finalize: true },
    });
    expect(approveAttempt.statusCode).toBe(404);

    // C4 fix: SSE stream must refuse to open for a foreign task.
    const streamB = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/stream`,
      headers: authHeaders(jwtB, b.tenantId),
    });
    expect(streamB.statusCode).toBe(404);
  });

  it("Tenant B cannot enumerate Tenant A's tasks via list", async () => {
    const a = await seedTenantWithOwner({ slug: 'list-a' });
    const b = await seedTenantWithOwner({ slug: 'list-b' });
    const jwtA = await mintJwt({ userId: a.userId, email: a.email });
    const jwtB = await mintJwt({ userId: b.userId, email: b.email });

    // A creates two tasks (no need to drain — list endpoint just reads rows).
    for (let i = 0; i < 2; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: authHeaders(jwtA, a.tenantId),
        payload: { brief: `A brief ${i}` },
      });
    }

    const listA = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: authHeaders(jwtA, a.tenantId),
    });
    expect(listA.statusCode).toBe(200);
    expect(listA.json()).toHaveLength(2);

    const listB = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: authHeaders(jwtB, b.tenantId),
    });
    expect(listB.statusCode).toBe(200);
    expect(listB.json()).toEqual([]);
  });

  it("Tenant B cannot present Tenant A's tenant id in the header", async () => {
    const a = await seedTenantWithOwner({ slug: 'spoof-a' });
    const b = await seedTenantWithOwner({ slug: 'spoof-b' });
    const jwtB = await mintJwt({ userId: b.userId, email: b.email });

    // B authenticates as themselves, but lies about tenant.
    const probe = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: authHeaders(jwtB, a.tenantId),
    });
    expect(probe.statusCode).toBe(403);
    expect(probe.json().error.code).toBe('forbidden');
  });
});
