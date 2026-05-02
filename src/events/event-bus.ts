import { EventEmitter } from 'node:events';

export interface TaskLogEvent {
  event: string;
  message: string;
  /** Who said this — drives the UI avatar/colour. See task_logs.speaker. */
  speaker?: string;
  data?: Record<string, unknown>;
  at: string;
  /** Present on tenant-level stream events so the client knows which task this belongs to. */
  taskId?: string;
}

/**
 * In-process EventBus for SSE fan-out.
 *
 * The runner publishes per-task; SSE handlers subscribe per-task and forward
 * events to the connected client. Backed by EventEmitter — single-process for MVP.
 *
 * Multi-process scale-out: replace with Postgres LISTEN/NOTIFY (cheap, already
 * have Postgres) or Redis pub/sub. The publish/subscribe interface stays the same.
 */
class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(taskId: string, event: TaskLogEvent): void {
    this.emitter.emit(`task:${taskId}`, event);
  }

  publishToTenant(tenantId: string, taskId: string, event: TaskLogEvent): void {
    this.emitter.emit(`tenant:${tenantId}`, { ...event, taskId });
  }

  subscribe(taskId: string, listener: (event: TaskLogEvent) => void): () => void {
    const channel = `task:${taskId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  subscribeToTenant(tenantId: string, listener: (event: TaskLogEvent) => void): () => void {
    const channel = `tenant:${tenantId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}

export const eventBus = new EventBus();
