import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IntakeMessage,
  type IntakeStatus,
  type NewTaskIntake,
  type Task,
  type TaskIntake,
  taskIntakes,
  tasks,
} from '../db/schema/index.js';
import { IllegalStateError, NotFoundError } from '../lib/errors.js';

export interface CreateIntakeInput {
  tenantId: string;
  createdBy?: string;
  /** First user message (the boss's initial ask). */
  firstMessage: string;
  /** First assistant reply produced by the intake agent for this turn. */
  firstAssistantReply: string;
  draftTitle?: string | null;
  draftBrief?: string | null;
}

/**
 * Create the intake row and seed the first turn (user + assistant) atomically
 * so the conversation never appears half-finished. Both the running draft
 * fields and the message log are populated by the same INSERT.
 */
export async function createIntake(input: CreateIntakeInput): Promise<TaskIntake> {
  const now = new Date();
  const userMsg: IntakeMessage = {
    role: 'user',
    content: input.firstMessage,
    createdAt: now.toISOString(),
  };
  const assistantMsg: IntakeMessage = {
    role: 'assistant',
    content: input.firstAssistantReply,
    createdAt: new Date(now.getTime() + 1).toISOString(),
  };
  const row: NewTaskIntake = {
    tenantId: input.tenantId,
    createdBy: input.createdBy,
    status: 'open',
    messages: [userMsg, assistantMsg],
    draftTitle: input.draftTitle ?? null,
    draftBrief: input.draftBrief ?? null,
  };
  const [created] = await db.insert(taskIntakes).values(row).returning();
  if (!created) throw new Error('Failed to create intake');
  return created;
}

export async function getIntake(tenantId: string, intakeId: string): Promise<TaskIntake> {
  const [intake] = await db
    .select()
    .from(taskIntakes)
    .where(and(eq(taskIntakes.id, intakeId), eq(taskIntakes.tenantId, tenantId)))
    .limit(1);
  if (!intake) throw new NotFoundError(`Intake ${intakeId}`);
  return intake;
}

export async function listIntakes(
  tenantId: string,
  filter?: { status?: IntakeStatus },
): Promise<TaskIntake[]> {
  const conditions = [eq(taskIntakes.tenantId, tenantId)];
  if (filter?.status) conditions.push(eq(taskIntakes.status, filter.status));
  return db
    .select()
    .from(taskIntakes)
    .where(and(...conditions))
    .orderBy(desc(taskIntakes.updatedAt));
}

/**
 * Append a turn to the conversation and update the running draft.
 *
 * Both the user message and the assistant reply are recorded in one update so
 * the conversation reads atomically — a partial failure can't leave a "user
 * sent X but no assistant reply" state visible to the UI.
 */
export async function appendTurn(
  tenantId: string,
  intakeId: string,
  patch: {
    userMessage: string;
    assistantReply: string;
    draftBrief?: string | null;
    draftTitle?: string | null;
  },
): Promise<TaskIntake> {
  const intake = await getIntake(tenantId, intakeId);
  if (intake.status !== 'open') {
    throw new IllegalStateError(`Intake is ${intake.status}, cannot append`);
  }
  const now = new Date();
  const userMsg: IntakeMessage = {
    role: 'user',
    content: patch.userMessage,
    createdAt: now.toISOString(),
  };
  const assistantMsg: IntakeMessage = {
    role: 'assistant',
    content: patch.assistantReply,
    createdAt: new Date(now.getTime() + 1).toISOString(),
  };
  const nextMessages = [...intake.messages, userMsg, assistantMsg];

  const [updated] = await db
    .update(taskIntakes)
    .set({
      messages: nextMessages,
      ...(patch.draftBrief !== undefined ? { draftBrief: patch.draftBrief } : {}),
      ...(patch.draftTitle !== undefined ? { draftTitle: patch.draftTitle } : {}),
      updatedAt: now,
    })
    .where(and(eq(taskIntakes.id, intakeId), eq(taskIntakes.tenantId, tenantId)))
    .returning();
  if (!updated) throw new NotFoundError(`Intake ${intakeId}`);
  return updated;
}

/**
 * Atomically transition `open → finalized` and create a backing task.
 *
 * Idempotent: if the intake is already finalized with a task, returns the same
 * pair instead of creating a duplicate. Callers (POST /intakes/:id/finalize)
 * can therefore retry safely on network jitter.
 *
 * The created task lands in `todo` status — the polling worker will pick it
 * up on the next tick and run it through the supervisor graph as usual.
 */
export async function finalizeIntake(
  tenantId: string,
  intakeId: string,
  override?: {
    title?: string;
    brief?: string;
    preferredAgent?: string;
    createdBy?: string;
  },
): Promise<{ intake: TaskIntake; task: Task }> {
  return db.transaction(async (tx) => {
    const [intake] = await tx
      .select()
      .from(taskIntakes)
      .where(and(eq(taskIntakes.id, intakeId), eq(taskIntakes.tenantId, tenantId)))
      .for('update')
      .limit(1);
    if (!intake) throw new NotFoundError(`Intake ${intakeId}`);

    if (intake.status === 'finalized' && intake.finalizedTaskId) {
      const [existingTask] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, intake.finalizedTaskId), eq(tasks.tenantId, tenantId)))
        .limit(1);
      if (existingTask) return { intake, task: existingTask };
    }

    if (intake.status !== 'open') {
      throw new IllegalStateError(`Intake is ${intake.status}, cannot finalize`);
    }

    const title = (override?.title ?? intake.draftTitle ?? '').trim();
    const brief = (override?.brief ?? intake.draftBrief ?? '').trim();
    if (!title) {
      throw new IllegalStateError('Intake has no draftTitle yet — keep talking or supply override');
    }
    if (!brief) {
      throw new IllegalStateError('Intake has no draftBrief yet — keep talking or supply override');
    }

    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId,
        title: title.slice(0, 120),
        description: brief,
        kind: 'execution',
        assignedAgent: override?.preferredAgent,
        status: 'todo',
        input: { brief, intakeId: intake.id },
        createdBy: override?.createdBy ?? intake.createdBy ?? undefined,
      })
      .returning();
    if (!task) throw new Error('Failed to spawn task from intake');

    const [updated] = await tx
      .update(taskIntakes)
      .set({
        status: 'finalized',
        finalizedTaskId: task.id,
        finalizedAt: new Date(),
        ...(override?.title ? { draftTitle: override.title } : {}),
        ...(override?.brief ? { draftBrief: override.brief } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(taskIntakes.id, intakeId), eq(taskIntakes.tenantId, tenantId)))
      .returning();
    if (!updated) throw new NotFoundError(`Intake ${intakeId}`);

    return { intake: updated, task };
  });
}

export async function abandonIntake(tenantId: string, intakeId: string): Promise<TaskIntake> {
  const intake = await getIntake(tenantId, intakeId);
  if (intake.status === 'abandoned') return intake;
  if (intake.status !== 'open') {
    throw new IllegalStateError(`Intake is ${intake.status}, cannot abandon`);
  }
  const [updated] = await db
    .update(taskIntakes)
    .set({ status: 'abandoned', updatedAt: new Date() })
    .where(and(eq(taskIntakes.id, intakeId), eq(taskIntakes.tenantId, tenantId)))
    .returning();
  if (!updated) throw new NotFoundError(`Intake ${intakeId}`);
  return updated;
}
