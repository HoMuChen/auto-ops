import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { agentRegistry } from '../agents/registry.js';
import { db } from '../db/client.js';
import {
  type NewTask,
  type Task,
  type TaskStatus,
  taskLogs,
  tasks,
  userStreamCursors,
} from '../db/schema/index.js';
import { eventBus } from '../events/event-bus.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import type { TaskOutput } from './output.js';
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
  const result = await db.transaction(async (tx) => {
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

    const output = (parent.output ?? {}) as TaskOutput;

    // Idempotent path: already spawned → just return existing children. Skip
    // the transition check so a retry against an already-done parent is a no-op.
    if (output.spawnedAt && output.spawnedTaskIds?.length) {
      const existing = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.tenantId, tenantId), eq(tasks.parentTaskId, taskId)));
      return { parent, children: existing, alreadySpawned: true as const };
    }

    assertTransition(parent.status, 'done');

    const specs = output.spawnTasks ?? [];

    // Defense in depth: refuse to insert children whose assignedAgent isn't in
    // the registry. The producing agent already validates this, but a stale
    // checkpoint, a renamed agent, or a manual DB write could otherwise leave
    // children unrunnable (worker would hit "node not found" in the graph).
    const unknownAssignees = specs
      .map((s) => s.assignedAgent)
      .filter((id) => !agentRegistry.has(id));
    if (unknownAssignees.length > 0) {
      throw new ValidationError(
        `spawnTasks reference unregistered agents: ${[...new Set(unknownAssignees)].join(', ')}`,
        { unknownAssignees: [...new Set(unknownAssignees)] },
      );
    }

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

    return { parent: updated, children, alreadySpawned: false as const };
  });

  // Best-effort timeline entry — not in the tx (a failed log insert mustn't
  // roll back the spawn). On idempotent re-entry (already spawned) we don't
  // re-log; the original entry is enough.
  if (!result.alreadySpawned && result.children.length > 0) {
    await appendTaskLog({
      tenantId,
      taskId,
      event: 'task.spawned',
      speaker: 'system',
      message: `已建立 ${result.children.length} 張子任務，員工陸續開工中`,
      data: { childTaskIds: result.children.map((c) => c.id) },
    });
  }

  return { parent: result.parent, children: result.children };
}

/**
 * Append a log line: persists for audit AND fans out on the EventBus so live
 * SSE consumers see it. This is the ONLY supported way to emit a task event —
 * callers must not call `eventBus.publish` directly, otherwise the timeline
 * and the live stream drift apart.
 */
export async function appendTaskLog(input: {
  tenantId: string;
  taskId: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  message: string;
  /**
   * Who is speaking. `'system'` for framework events, `'supervisor'` for the
   * routing LLM, otherwise an agent id. Drives the UI avatar/colour so the
   * kanban timeline reads like a Slack thread instead of a syslog.
   */
  speaker?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(taskLogs).values({
    tenantId: input.tenantId,
    taskId: input.taskId,
    level: input.level ?? 'info',
    event: input.event,
    message: input.message,
    speaker: input.speaker ?? null,
    data: input.data,
  });
  const logEvent = {
    event: input.event,
    message: input.message,
    ...(input.speaker ? { speaker: input.speaker } : {}),
    ...(input.data ? { data: input.data } : {}),
    at: new Date().toISOString(),
  };
  eventBus.publish(input.taskId, logEvent);
  eventBus.publishToTenant(input.tenantId, input.taskId, logEvent);
}

export async function listTenantLogs(
  tenantId: string,
  opts?: { since?: Date; until?: Date; limit?: number },
): Promise<
  {
    id: string;
    taskId: string;
    createdAt: Date;
    level: string;
    event: string;
    speaker: string | null;
    message: string;
    data: Record<string, unknown> | null;
  }[]
> {
  const conditions = [eq(taskLogs.tenantId, tenantId)];
  if (opts?.since) conditions.push(gt(taskLogs.createdAt, opts.since));
  if (opts?.until) conditions.push(lte(taskLogs.createdAt, opts.until));

  return db
    .select({
      id: taskLogs.id,
      taskId: taskLogs.taskId,
      createdAt: taskLogs.createdAt,
      level: taskLogs.level,
      event: taskLogs.event,
      speaker: taskLogs.speaker,
      message: taskLogs.message,
      data: taskLogs.data,
    })
    .from(taskLogs)
    .where(and(...conditions))
    .orderBy(asc(taskLogs.createdAt))
    .limit(opts?.limit ?? 500);
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
    speaker: string | null;
    message: string;
    data: Record<string, unknown> | null;
  }[]
> {
  const conditions = [eq(taskLogs.tenantId, tenantId), eq(taskLogs.taskId, taskId)];
  if (opts?.since) conditions.push(gt(taskLogs.createdAt, opts.since));

  return db
    .select({
      id: taskLogs.id,
      createdAt: taskLogs.createdAt,
      level: taskLogs.level,
      event: taskLogs.event,
      speaker: taskLogs.speaker,
      message: taskLogs.message,
      data: taskLogs.data,
    })
    .from(taskLogs)
    .where(and(...conditions))
    .orderBy(asc(taskLogs.createdAt))
    .limit(opts?.limit ?? 500);
}

export async function getStreamCursor(userId: string, tenantId: string): Promise<Date | null> {
  const [row] = await db
    .select({ cursorAt: userStreamCursors.cursorAt })
    .from(userStreamCursors)
    .where(and(eq(userStreamCursors.userId, userId), eq(userStreamCursors.tenantId, tenantId)))
    .limit(1);
  return row?.cursorAt ?? null;
}

export async function upsertStreamCursor(
  userId: string,
  tenantId: string,
  cursorAt: Date,
): Promise<void> {
  await db
    .insert(userStreamCursors)
    .values({ userId, tenantId, cursorAt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [userStreamCursors.userId, userStreamCursors.tenantId],
      set: { cursorAt, updatedAt: new Date() },
    });
}
