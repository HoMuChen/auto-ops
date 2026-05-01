import { claimNextTask } from '../../../src/tasks/repository.js';
import { runTaskThroughGraph } from '../../../src/tasks/runner.js';

/**
 * Manually drive one worker iteration.
 *
 * Tests use this instead of running the real `TaskWorker` polling loop so the
 * end-to-end behavior of `claimNextTask` (the actual SQL with FOR UPDATE SKIP
 * LOCKED + lease) and `runTaskThroughGraph` (the LangGraph invocation +
 * checkpoint write + status transitions) is exercised, but timing is
 * deterministic.
 */
export async function drainNextTask(opts?: { workerId?: string; leaseMs?: number }): Promise<{
  claimed: boolean;
  taskId?: string;
}> {
  const task = await claimNextTask({
    workerId: opts?.workerId ?? 'test-worker',
    leaseMs: opts?.leaseMs ?? 60_000,
  });
  if (!task) return { claimed: false };
  await runTaskThroughGraph(task);
  return { claimed: true, taskId: task.id };
}
