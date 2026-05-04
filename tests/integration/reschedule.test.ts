import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';

const { createTestApp } = await import('./helpers/app.js');
const { claimNextTask, getTask } = await import('../../src/tasks/repository.js');

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

describe('PATCH /tasks/:taskId — reschedule', () => {
  async function seedTask(scheduledAt?: string): Promise<{
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
      payload: { brief: 'placeholder brief', ...(scheduledAt ? { scheduledAt } : {}) },
    });
    expect(create.statusCode).toBe(201);
    return { tenantId, userId, jwt, taskId: create.json().id as string };
  }

  it('moves a future scheduledAt to a new future time', async () => {
    const future1 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const future2 = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const { tenantId, jwt, taskId } = await seedTask(future1);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${taskId}`,
      headers: authHeaders(jwt, tenantId),
      payload: { scheduledAt: future2 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().scheduledAt).toBe(future2);

    const task = await getTask(tenantId, taskId);
    expect(task.scheduledAt?.toISOString()).toBe(future2);
    expect(task.status).toBe('todo');
  });

  it('clears scheduledAt with null and makes the task immediately claimable', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { tenantId, jwt, taskId } = await seedTask(future);

    // Pre-condition: task is not claimable (scheduled in the future).
    const before = await claimNextTask({ workerId: 'test-worker', leaseMs: 30_000 });
    expect(before).toBeNull();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${taskId}`,
      headers: authHeaders(jwt, tenantId),
      payload: { scheduledAt: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().scheduledAt).toBeNull();

    const claimed = await claimNextTask({ workerId: 'test-worker', leaseMs: 30_000 });
    expect(claimed?.id).toBe(taskId);
  });

  it('rejects 422 when the task is not in todo (already claimed)', async () => {
    const { tenantId, jwt, taskId } = await seedTask();

    // Simulate a worker claiming the task — moves it to in_progress + sets lock.
    const claimed = await claimNextTask({ workerId: 'test-worker', leaseMs: 30_000 });
    expect(claimed?.id).toBe(taskId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${taskId}`,
      headers: authHeaders(jwt, tenantId),
      payload: { scheduledAt: new Date(Date.now() + 60_000).toISOString() },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('illegal_state');
  });

  it('rejects 404 across tenants', async () => {
    const { taskId } = await seedTask();
    const other = await seedTenantWithOwner();
    const otherJwt = await mintJwt({ userId: other.userId, email: other.email });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${taskId}`,
      headers: authHeaders(otherJwt, other.tenantId),
      payload: { scheduledAt: null },
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects malformed body (400 on bad datetime)', async () => {
    const { tenantId, jwt, taskId } = await seedTask();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${taskId}`,
      headers: authHeaders(jwt, tenantId),
      payload: { scheduledAt: 'not-a-date' },
    });
    expect(res.statusCode).toBe(400);
  });
});
