import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { claimNextTask, reclaimExpiredLocks } from './repository.js';
import { runTaskThroughGraph } from './runner.js';

/**
 * Polling worker — drains the tasks table.
 *
 * Loop:
 *   every WORKER_POLL_INTERVAL_MS:
 *     - reclaim expired locks (crashed workers)
 *     - while concurrency < max: claim next task; spawn runner
 *
 * Concurrency: tracked in-memory; one worker process can run up to
 * WORKER_MAX_CONCURRENCY tasks at once. Horizontal scale = more processes.
 */
export class TaskWorker {
  private workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private inflight = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private log = logger.child({ component: 'TaskWorker', workerId: this.workerId });

  start(): void {
    if (this.timer) return;
    this.log.info({ pollIntervalMs: env.WORKER_POLL_INTERVAL_MS }, 'TaskWorker starting');
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Best-effort drain wait
    const start = Date.now();
    while (this.inflight > 0 && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.log.info('TaskWorker stopped');
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick().catch((err) => this.log.error({ err }, 'tick error'));
    }, env.WORKER_POLL_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    try {
      const reclaimed = await reclaimExpiredLocks();
      if (reclaimed > 0) this.log.info({ reclaimed }, 'reclaimed expired locks');

      let claimedThisTick = 0;
      while (this.inflight < env.WORKER_MAX_CONCURRENCY) {
        const task = await claimNextTask({
          workerId: this.workerId,
          leaseMs: 5 * 60_000, // 5 min lease
        });
        if (!task) break;

        this.inflight += 1;
        claimedThisTick += 1;
        this.log.info({ taskId: task.id }, 'claimed task');

        // Fire and forget; the runner handles its own errors and final status updates.
        runTaskThroughGraph(task)
          .catch((err) => this.log.error({ err, taskId: task.id }, 'runner crashed'))
          .finally(() => {
            this.inflight -= 1;
          });
      }

      // Heartbeat at debug level — visible only when LOG_LEVEL=debug. Confirms
      // the worker is alive when the queue is empty (otherwise idle ticks are
      // silent and it's hard to tell whether the loop has stalled).
      this.log.debug(
        { claimed: claimedThisTick, inflight: this.inflight, reclaimed },
        'tick',
      );
    } finally {
      this.scheduleNext();
    }
  }
}
