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

  /** Lightweight internal signals (not SSE — no payload, just a nudge). */
  signal(channel: string): void {
    this.emitter.emit(`signal:${channel}`);
  }

  onSignal(channel: string, cb: () => void): () => void {
    const ch = `signal:${channel}`;
    this.emitter.on(ch, cb);
    return () => this.emitter.off(ch, cb);
  }

  /**
   * Typed domain event for task lifecycle. Fires once per terminal `done`
   * transition (regular agent completion, strategy spawn finalize, approve
   * (finalize=true)). Listeners are fire-and-forget — they MUST NOT throw
   * back into the emitter, since failures (e.g. notifications) must never
   * roll back the task transition itself.
   */
  publishTaskCompleted(payload: { taskId: string; tenantId: string }): void {
    this.emitter.emit('task.completed', payload);
  }

  onTaskCompleted(cb: (payload: { taskId: string; tenantId: string }) => void): () => void {
    this.emitter.on('task.completed', cb);
    return () => this.emitter.off('task.completed', cb);
  }
}

export const eventBus = new EventBus();
