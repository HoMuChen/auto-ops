import type { TaskStatus } from '../db/schema/index.js';
import { IllegalStateError } from '../lib/errors.js';

/**
 * Explicit transition table. Any change to task status must go through `transition()`
 * so that illegal transitions throw immediately rather than silently corrupting state.
 *
 *   todo → in_progress             (worker claims it)
 *   in_progress → waiting          (HITL gate requested by agent)
 *   in_progress → done             (final success)
 *   in_progress → failed           (unrecoverable error)
 *   in_progress → todo             (retry — bumps attempt counter)
 *   waiting → in_progress          (user Approve/Feedback resumes)
 *   waiting → done                 (user Approve as final answer)
 *   waiting → failed               (user Discard)
 *   * → failed                     (admin force-fail)
 */
const allowed: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'failed'],
  in_progress: ['waiting', 'done', 'failed', 'todo'],
  waiting: ['in_progress', 'done', 'failed'],
  done: [],
  failed: ['todo'], // allow manual retry
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowed[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalStateError(`Illegal task transition: ${from} → ${to}`);
  }
}
