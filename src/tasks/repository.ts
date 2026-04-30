import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
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
  patch?: Partial<Pick<Task, 'output' | 'error' | 'assignedAgent'>>,
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
 */
export async function claimNextTask(opts: {
  workerId: string;
  leaseMs: number;
}): Promise<Task | null> {
  // postgres-js doesn't always coerce Date inside drizzle's sql tag — pass an
  // ISO string and let Postgres parse it as timestamptz.
  const leaseUntil = new Date(Date.now() + opts.leaseMs).toISOString();

  const result = await db.execute<Task>(sql`
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
    RETURNING *
  `);

  const row = (result as unknown as { rows?: Task[] }).rows?.[0] ?? (result as Task[])[0];
  return row ?? null;
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
