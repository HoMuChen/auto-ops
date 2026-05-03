import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { eventBus } from '../events/event-bus.js';
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
 * Also reacts to the 'task.ready' signal emitted by the API layer when a
 * new task is created or strategy children are spawned, so immediately-
 * runnable tasks start without waiting for the next poll interval.
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
  private unsubSignal: (() => void) | null = null;

  start(): void {
    if (this.timer) return;
    this.log.info({ pollIntervalMs: env.WORKER_POLL_INTERVAL_MS }, 'TaskWorker starting');
    this.unsubSignal = eventBus.onSignal('task.ready', () => this.kick());
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubSignal?.();
    this.unsubSignal = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Best-effort drain wait
    const start = Date.now();
    while (this.inflight > 0 && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.log.info('TaskWorker stopped');
  }

  /** Interrupt the pending poll timer and run a tick immediately. */
  kick(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tick().catch((err) => this.log.error({ err }, 'kicked tick error'));
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

      this.log.debug({ claimed: claimedThisTick, inflight: this.inflight }, 'tick');
    } finally {
      this.scheduleNext();
    }
  }
}
