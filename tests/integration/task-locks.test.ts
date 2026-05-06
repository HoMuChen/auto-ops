import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';

const { createTestApp } = await import('./helpers/app.js');
const { claimNextTask, extendLock, getTask, releaseLock, updateTaskStatus } = await import(
  '../../src/tasks/repository.js'
);
const { LockLostError } = await import('../../src/lib/errors.js');

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

async function seedClaimedTask(workerId: string): Promise<{ tenantId: string; taskId: string }> {
  const { tenantId, userId, email } = await seedTenantWithOwner();
  const jwt = await mintJwt({ userId, email });
  const create = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: authHeaders(jwt, tenantId),
    payload: { brief: 'lock test brief' },
  });
  expect(create.statusCode).toBe(201);
  const taskId = create.json().id as string;
  const claimed = await claimNextTask({ workerId, leaseMs: 60_000 });
  expect(claimed?.id).toBe(taskId);
  return { tenantId, taskId };
}

describe('task lock heartbeat & owner guard', () => {
  it('extendLock pushes locked_until forward when caller owns the lock', async () => {
    const { tenantId, taskId } = await seedClaimedTask('worker-A');
    const before = await getTask(tenantId, taskId);
    expect(before.lockedUntil).not.toBeNull();

    const ok = await extendLock(taskId, 'worker-A', 5 * 60_000);
    expect(ok).toBe(true);

    const after = await getTask(tenantId, taskId);
    expect(after.lockedUntil!.getTime()).toBeGreaterThan(before.lockedUntil!.getTime());
  });

  it('extendLock returns false when another worker owns the lock', async () => {
    const { taskId } = await seedClaimedTask('worker-A');
    const ok = await extendLock(taskId, 'worker-B', 5 * 60_000);
    expect(ok).toBe(false);
  });

  it('updateTaskStatus with matching expectedLockedBy succeeds', async () => {
    const { tenantId, taskId } = await seedClaimedTask('worker-A');
    const updated = await updateTaskStatus(tenantId, taskId, 'failed', undefined, 'worker-A');
    expect(updated.status).toBe('failed');
  });

  it('updateTaskStatus throws LockLostError when expectedLockedBy mismatches', async () => {
    const { tenantId, taskId } = await seedClaimedTask('worker-A');
    await expect(
      updateTaskStatus(tenantId, taskId, 'failed', undefined, 'worker-B'),
    ).rejects.toBeInstanceOf(LockLostError);
    // Status must remain unchanged after the rejected attempt.
    const after = await getTask(tenantId, taskId);
    expect(after.status).toBe('in_progress');
  });

  it('releaseLock with mismatched owner is a no-op', async () => {
    const { tenantId, taskId } = await seedClaimedTask('worker-A');
    await releaseLock(taskId, 'worker-B');
    const after = await getTask(tenantId, taskId);
    expect(after.lockedBy).toBe('worker-A');
    expect(after.lockedUntil).not.toBeNull();
  });

  it('releaseLock with matching owner clears the lock', async () => {
    const { tenantId, taskId } = await seedClaimedTask('worker-A');
    await releaseLock(taskId, 'worker-A');
    const after = await getTask(tenantId, taskId);
    expect(after.lockedBy).toBeNull();
    expect(after.lockedUntil).toBeNull();
  });
});
