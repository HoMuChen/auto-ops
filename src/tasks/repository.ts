import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { SpawnTaskRequest } from '../agents/types.js';
import { db } from '../db/client.js';
import { type NewTask, type Task, type TaskStatus, taskLogs, tasks } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';
import { assertTransition } from './state-machine.js';

export interface CreateTaskInput {
  tenantId: string;
  title: string;
  description?: string;
  kind?: 'strategy' | 'execution';
  assignedAgent?: string;
  parentTaskId?: string;
  input?: Record<string, unknown>;
  scheduledAt?: Date;
  createdBy?: string;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const row: NewTask = {
    tenantId: input.tenantId,
    title: input.title,
    description: input.description,
    kind: input.kind ?? 'execution',
    assignedAgent: input.assignedAgent,
    parentTaskId: input.parentTaskId,
    input: input.input ?? {},
    scheduledAt: input.scheduledAt,
    createdBy: input.createdBy,
    status: 'todo',
  };
  const [created] = await db.insert(tasks).values(row).returning();
  if (!created) throw new Error('Failed to create task');
  return created;
}

export async function getTask(tenantId: string, taskId: string): Promise<Task> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)))
    .limit(1);
  if (!task) throw new NotFoundError(`Task ${taskId}`);
  return task;
}

export async function listTasks(
  tenantId: string,
  filter?: { status?: TaskStatus; parentTaskId?: string | null },
): Promise<Task[]> {
  const conditions = [eq(tasks.tenantId, tenantId)];
  if (filter?.status) conditions.push(eq(tasks.status, filter.status));
  if (filter?.parentTaskId === null) conditions.push(isNull(tasks.parentTaskId));
  else if (filter?.parentTaskId) conditions.push(eq(tasks.parentTaskId, filter.parentTaskId));

  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt));
}

export async function updateTaskStatus(
  tenantId: string,
  taskId: string,
  to: TaskStatus,
  patch?: Partial<Pick<Task, 'output' | 'error' | 'assignedAgent' | 'kind'>>,
): Promise<Task> {
  const current = await getTask(tenantId, taskId);
  assertTransition(current.status, to);

  const [updated] = await db
    .update(tasks)
    .set({
      status: to,
      ...patch,
      ...(to === 'done' || to === 'failed' ? { completedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)))
    .returning();

  if (!updated) throw new NotFoundError(`Task ${taskId}`);
  return updated;
}

/**
 * Atomic task claim — used by the polling worker.
 *
 * Picks the oldest eligible task (status='todo', scheduled_at due, no live lock)
 * and stamps it with `locked_by` + `locked_until` + status='in_progress' in a
 * single UPDATE. Returns null if no task is available.
 *
 * Implementation note: the UPDATE returns only the claimed `id`, then we
 * re-select with the Drizzle query builder so the result has properly mapped
 * camelCase fields (raw `db.execute(sql\`...\`)` returns snake_case rows from
 * postgres-js, which would silently make `task.tenantId` undefined).
 */
export async function claimNextTask(opts: {
  workerId: string;
  leaseMs: number;
}): Promise<Task | null> {
  // postgres-js doesn't always coerce Date inside drizzle's sql tag — pass an
  // ISO string and let Postgres parse it as timestamptz.
  const leaseUntil = new Date(Date.now() + opts.leaseMs).toISOString();

  const result = await db.execute<{ id: string }>(sql`
    UPDATE tasks
    SET status = 'in_progress',
        locked_by = ${opts.workerId},
        locked_until = ${leaseUntil}::timestamptz,
        updated_at = now()
    WHERE id = (
      SELECT id FROM tasks
      WHERE status = 'todo'
        AND (scheduled_at IS NULL OR scheduled_at <= now())
        AND (locked_until IS NULL OR locked_until <= now())
      ORDER BY COALESCE(scheduled_at, created_at) ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `);

  const rows =
    (result as unknown as { rows?: { id: string }[] }).rows ?? (result as { id: string }[]);
  const claimedId = rows[0]?.id;
  if (!claimedId) return null;

  const [task] = await db.select().from(tasks).where(eq(tasks.id, claimedId)).limit(1);
  return task ?? null;
}

export async function releaseLock(taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ lockedBy: null, lockedUntil: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

export async function reclaimExpiredLocks(): Promise<number> {
  const result = await db
    .update(tasks)
    .set({ status: 'todo', lockedBy: null, lockedUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.status, 'in_progress'),
        or(isNull(tasks.lockedUntil), lte(tasks.lockedUntil, new Date())),
      ),
    )
    .returning({ id: tasks.id });
  return result.length;
}

/**
 * Atomic strategy-task finalisation.
 *
 * Reads the parent's `output.spawnTasks`, creates one execution-kind child per
 * spec, transitions the parent to `done`, and stamps `output.spawnedTaskIds`
 * + `output.spawnedAt` so a retry of the same approve call is a no-op.
 *
 * Idempotency: if `output.spawnedAt` is already set, returns the existing
 * children without re-inserting. This keeps the approve API safe to retry
 * and protects against double-spawn under network jitter.
 *
 * Throws if the parent isn't a strategy task or isn't currently `waiting`.
 */
export async function finalizeStrategyTask(
  tenantId: string,
  taskId: string,
): Promise<{ parent: Task; children: Task[] }> {
  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)))
      .for('update')
      .limit(1);
    if (!parent) throw new NotFoundError(`Task ${taskId}`);
    if (parent.kind !== 'strategy') {
      throw new Error(`Task ${taskId} is not a strategy task (kind=${parent.kind})`);
    }

    const output = (parent.output ?? {}) as Record<string, unknown> & {
      spawnTasks?: SpawnTaskRequest[];
      spawnedAt?: string;
      spawnedTaskIds?: string[];
    };

    // Idempotent path: already spawned → just return existing children. Skip
    // the transition check so a retry against an already-done parent is a no-op.
    if (output.spawnedAt && output.spawnedTaskIds?.length) {
      const existing = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.tenantId, tenantId), eq(tasks.parentTaskId, taskId)));
      return { parent, children: existing };
    }

    assertTransition(parent.status, 'done');

    const specs = output.spawnTasks ?? [];
    const children: Task[] = [];
    for (const spec of specs) {
      const row: NewTask = {
        tenantId,
        parentTaskId: taskId,
        title: spec.title,
        description: spec.description,
        kind: 'execution',
        assignedAgent: spec.assignedAgent,
        input: spec.input,
        scheduledAt: spec.scheduledAt ? new Date(spec.scheduledAt) : undefined,
        status: 'todo',
      };
      const [created] = await tx.insert(tasks).values(row).returning();
      if (!created) throw new Error('Child task insert returned no row');
      children.push(created);
    }

    const nextOutput = {
      ...output,
      spawnTasks: undefined,
      spawnedAt: new Date().toISOString(),
      spawnedTaskIds: children.map((c) => c.id),
    };

    const [updated] = await tx
      .update(tasks)
      .set({
        status: 'done',
        output: nextOutput,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)))
      .returning();
    if (!updated) throw new NotFoundError(`Task ${taskId}`);

    return { parent: updated, children };
  });
}

/** Append a log line; persists for audit and is fanned out via the EventBus. */
export async function appendTaskLog(input: {
  tenantId: string;
  taskId: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  message: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(taskLogs).values({
    tenantId: input.tenantId,
    taskId: input.taskId,
    level: input.level ?? 'info',
    event: input.event,
    message: input.message,
    data: input.data,
  });
}

export async function listTaskLogs(
  tenantId: string,
  taskId: string,
  opts?: { since?: Date; limit?: number },
): Promise<
  {
    id: string;
    createdAt: Date;
    level: string;
    event: string;
    message: string;
    data: Record<string, unknown> | null;
  }[]
> {
  const conditions = [eq(taskLogs.tenantId, tenantId), eq(taskLogs.taskId, taskId)];
  if (opts?.since) conditions.push(sql`${taskLogs.createdAt} > ${opts.since}`);

  return db
    .select({
      id: taskLogs.id,
      createdAt: taskLogs.createdAt,
      level: taskLogs.level,
      event: taskLogs.event,
      message: taskLogs.message,
      data: taskLogs.data,
    })
    .from(taskLogs)
    .where(and(...conditions))
    .orderBy(asc(taskLogs.createdAt))
    .limit(opts?.limit ?? 500);
}
