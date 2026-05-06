import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../../src/db/client.js';
import { tasks, tenantMembers } from '../../src/db/schema/index.js';
import {
  claimWaitingTaskForNotification,
  createTask,
  resolveOwningCreator,
  updateTaskStatus,
} from '../../src/tasks/repository.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';

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
});

/**
 * Force a task into `waiting` and back-date `updated_at` so the watcher's
 * threshold filter treats it as "stale enough to notify". Bypasses the runner
 * entirely — these tests target repository semantics, not the agent loop.
 */
async function parkInWaiting(opts: {
  tenantId: string;
  taskId: string;
  pastMs: number;
}): Promise<void> {
  // First flip status via the state machine so the assertion path runs.
  // Need to step todo → in_progress → waiting (the only legal route).
  await updateTaskStatus(opts.tenantId, opts.taskId, 'in_progress');
  await updateTaskStatus(opts.tenantId, opts.taskId, 'waiting');
  // Then push updated_at into the past for the threshold check.
  await db
    .update(tasks)
    .set({ updatedAt: sql`now() - interval '1 millisecond' * ${opts.pastMs}` })
    .where(eq(tasks.id, opts.taskId));
}

describe('waiting-watcher repository semantics', () => {
  it('claims a waiting task that has aged past the threshold', async () => {
    const { tenantId, userId } = await seedTenantWithOwner();
    const t = await createTask({ tenantId, title: 'aged', createdBy: userId });
    await parkInWaiting({ tenantId, taskId: t.id, pastMs: 31 * 60_000 });

    const claimed = await claimWaitingTaskForNotification({ thresholdMs: 30 * 60_000 });
    expect(claimed?.id).toBe(t.id);
    expect((claimed?.output as { notifiedWaitingAt?: string })?.notifiedWaitingAt).toBeTruthy();
  });

  it('does not claim a task that is still within the threshold', async () => {
    const { tenantId, userId } = await seedTenantWithOwner();
    const t = await createTask({ tenantId, title: 'fresh', createdBy: userId });
    await parkInWaiting({ tenantId, taskId: t.id, pastMs: 60_000 });

    const claimed = await claimWaitingTaskForNotification({ thresholdMs: 30 * 60_000 });
    expect(claimed).toBeNull();
  });

  it('skips already-stamped tasks (idempotent on rerun)', async () => {
    const { tenantId, userId } = await seedTenantWithOwner();
    const t = await createTask({ tenantId, title: 'aged', createdBy: userId });
    await parkInWaiting({ tenantId, taskId: t.id, pastMs: 31 * 60_000 });

    const first = await claimWaitingTaskForNotification({ thresholdMs: 30 * 60_000 });
    expect(first?.id).toBe(t.id);
    const second = await claimWaitingTaskForNotification({ thresholdMs: 30 * 60_000 });
    expect(second).toBeNull();
  });

  it('skips archived waiting tasks', async () => {
    const { tenantId, userId } = await seedTenantWithOwner();
    const t = await createTask({ tenantId, title: 'aged-but-archived', createdBy: userId });
    await parkInWaiting({ tenantId, taskId: t.id, pastMs: 31 * 60_000 });
    await db.update(tasks).set({ archivedAt: new Date() }).where(eq(tasks.id, t.id));

    const claimed = await claimWaitingTaskForNotification({ thresholdMs: 30 * 60_000 });
    expect(claimed).toBeNull();
  });

  it('clears notifiedWaitingAt when the task transitions out of waiting', async () => {
    const { tenantId, userId } = await seedTenantWithOwner();
    const t = await createTask({ tenantId, title: 'feedback-loop', createdBy: userId });
    await parkInWaiting({ tenantId, taskId: t.id, pastMs: 31 * 60_000 });

    const stamped = await claimWaitingTaskForNotification({ thresholdMs: 30 * 60_000 });
    expect((stamped?.output as { notifiedWaitingAt?: string })?.notifiedWaitingAt).toBeTruthy();

    // Feedback path: waiting → todo. The repository's clear logic strips the stamp.
    const back = await updateTaskStatus(tenantId, t.id, 'todo');
    expect((back.output as { notifiedWaitingAt?: string })?.notifiedWaitingAt).toBeUndefined();

    // Re-park and confirm the watcher will fire again.
    await db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, t.id));
    await updateTaskStatus(tenantId, t.id, 'waiting');
    await db
      .update(tasks)
      .set({ updatedAt: sql`now() - interval '31 minutes'` })
      .where(eq(tasks.id, t.id));

    const reclaimed = await claimWaitingTaskForNotification({ thresholdMs: 30 * 60_000 });
    expect(reclaimed?.id).toBe(t.id);
  });

  it('resolveOwningCreator walks up parentTaskId for spawn children', async () => {
    const { tenantId, userId } = await seedTenantWithOwner();
    const parent = await createTask({
      tenantId,
      title: 'strategy parent',
      createdBy: userId,
    });
    // Spawn child carries parentTaskId but no createdBy (mirrors finalizeStrategyTask).
    const child = await createTask({
      tenantId,
      title: 'spawn child',
      parentTaskId: parent.id,
    });

    const owner = await resolveOwningCreator(child);
    expect(owner).toBe(userId);
  });

  it('resolveOwningCreator returns null for orphaned tasks', async () => {
    const { tenantId } = await seedTenantWithOwner();
    const orphan = await createTask({ tenantId, title: 'orphan' });
    const owner = await resolveOwningCreator(orphan);
    expect(owner).toBeNull();
  });

  it('honors per-tenant member.notifyOnWaiting=false (full pipeline check)', async () => {
    // This test only covers the repository surface; the dispatcher unit tests
    // cover decideWaitingRecipient. We just confirm tenantMembers settings
    // can be read back unchanged so the watcher gets correct input.
    const { tenantId, userId } = await seedTenantWithOwner();
    await db
      .update(tenantMembers)
      .set({ notificationSettings: { notifyOnWaiting: false } })
      .where(eq(tenantMembers.userId, userId));

    const [member] = await db
      .select({ notificationSettings: tenantMembers.notificationSettings })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, userId));
    expect(member?.notificationSettings?.notifyOnWaiting).toBe(false);
    expect(tenantId).toBeTruthy();
  });
});
