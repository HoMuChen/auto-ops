import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';

const { createTestApp } = await import('./helpers/app.js');
const { claimNextTask, getTask, updateTaskStatus } = await import('../../src/tasks/repository.js');

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

describe('POST /tasks/:taskId/archive', () => {
  async function seedTask(): Promise<{
    tenantId: string;
    userId: string;
    jwt: string;
    taskId: string;
  }> {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'placeholder brief' },
    });
    expect(create.statusCode).toBe(201);
    return { tenantId, userId, jwt, taskId: create.json().id as string };
  }

  it('archives a todo task and stamps archivedAt', async () => {
    const { tenantId, jwt, taskId } = await seedTask();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(jwt, tenantId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedAt).toBeTruthy();
  });

  it('archived tasks disappear from GET /tasks', async () => {
    const { tenantId, jwt, taskId } = await seedTask();
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(jwt, tenantId),
    });
    const list = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).find((t) => t.id === taskId)).toBeUndefined();
  });

  it('archived todo task is not claimable by the worker', async () => {
    const { tenantId, jwt, taskId } = await seedTask();
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(jwt, tenantId),
    });
    const claimed = await claimNextTask({ workerId: 'test-worker', leaseMs: 30_000 });
    expect(claimed).toBeNull();
  });

  it('GET /tasks/:id still returns the archived task (deep-link works)', async () => {
    const { tenantId, jwt, taskId } = await seedTask();
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(jwt, tenantId),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: authHeaders(jwt, tenantId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(taskId);
    expect(res.json().archivedAt).toBeTruthy();
  });

  it('rejects 422 when task is in_progress', async () => {
    const { tenantId, jwt, taskId } = await seedTask();
    // Worker claims it → status flips to in_progress.
    const claimed = await claimNextTask({ workerId: 'test-worker', leaseMs: 30_000 });
    expect(claimed?.id).toBe(taskId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(jwt, tenantId),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('illegal_state');
  });

  it('archives a done task', async () => {
    const { tenantId, jwt, taskId } = await seedTask();
    await claimNextTask({ workerId: 'test-worker', leaseMs: 30_000 });
    await updateTaskStatus(tenantId, taskId, 'done');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(jwt, tenantId),
    });
    expect(res.statusCode).toBe(200);
  });

  it('archives a failed task', async () => {
    const { tenantId, jwt, taskId } = await seedTask();
    await claimNextTask({ workerId: 'test-worker', leaseMs: 30_000 });
    await updateTaskStatus(tenantId, taskId, 'failed', { error: { message: 'boom' } });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(jwt, tenantId),
    });
    expect(res.statusCode).toBe(200);
  });

  it('is idempotent — second call returns the same archivedAt', async () => {
    const { tenantId, jwt, taskId } = await seedTask();
    const first = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(jwt, tenantId),
    });
    expect(first.statusCode).toBe(200);
    const firstAt = first.json().archivedAt as string;

    const second = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(jwt, tenantId),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().archivedAt).toBe(firstAt);

    const after = await getTask(tenantId, taskId);
    expect(after.archivedAt?.toISOString()).toBe(firstAt);
  });

  it('rejects 404 across tenants', async () => {
    const { taskId } = await seedTask();
    const other = await seedTenantWithOwner();
    const otherJwt = await mintJwt({ userId: other.userId, email: other.email });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/archive`,
      headers: authHeaders(otherJwt, other.tenantId),
    });
    expect(res.statusCode).toBe(404);
  });
});
