import type { PendingToolCall, SpawnTaskRequest } from '../agents/types.js';
import type { Task } from '../db/schema/index.js';
import type { Artifact } from './artifact.js';

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
  /** Typed deliverable. UI dispatches on artifact.kind. */
  artifact?: Artifact;

  /** HITL: agent declared children to spawn on approve(finalize=true). */
  spawnTasks?: SpawnTaskRequest[];
  /** Stamped after finalizeStrategyTask spawns the children (idempotency). */
  spawnedAt?: string;
  spawnedTaskIds?: string[];

  /** HITL: tool the framework will fire on approve(finalize=true). */
  pendingToolCall?: PendingToolCall;
  /** Stamped after the post-HITL tool execution (idempotency). */
  toolExecutedAt?: string;

  /** HITL: shopify-blog-writer Stage 1 — boss must answer EEAT questions. */
  eeatPending?: {
    questions: { question: string; hint?: string; optional?: boolean }[];
    askedAt: string;
  };

  generatedImageIds?: string[];
  /** Escape hatch — should be empty in steady state. */
  [key: string]: unknown;
}

/** Read the framework-typed view of `task.output` (never returns null). */
export function readTaskOutput(task: Task): TaskOutput {
  return (task.output ?? {}) as TaskOutput;
}
