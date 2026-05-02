import type { PendingToolCall, SpawnTaskRequest } from '../agents/types.js';
import type { Task } from '../db/schema/index.js';

/**
 * The shape persisted on `tasks.output`. Drizzle types the column as
 * `Record<string, unknown>` because agents stamp arbitrary payload keys
 * (article, listing, language, …) — this type names the framework-controlled
 * keys explicitly so callers stop hand-rolling the same inline cast.
 *
 * Lifecycle of the stamped keys:
 *
 *   strategy task:
 *     spawnTasks (set by agent) → spawnedAt + spawnedTaskIds (set by
 *     finalizeStrategyTask, replaces spawnTasks)
 *
 *   HITL tool task:
 *     pendingToolCall (set by agent) → toolResult + toolExecutedAt (set by
 *     executeApprovedToolCall, replaces pendingToolCall)
 */
export interface TaskOutput {
  spawnTasks?: SpawnTaskRequest[];
  spawnedAt?: string;
  spawnedTaskIds?: string[];
  pendingToolCall?: PendingToolCall;
  toolResult?: unknown;
  toolExecutedAt?: string;
  generatedImageIds?: string[];
  eeatPending?: {
    questions: { question: string; hint?: string; optional?: boolean }[];
    askedAt: string;
  };
  /** Agent payload keys (article, listing, plan, language…). */
  [key: string]: unknown;
}

/** Read the framework-typed view of `task.output` (never returns null). */
export function readTaskOutput(task: Task): TaskOutput {
  return (task.output ?? {}) as TaskOutput;
}
