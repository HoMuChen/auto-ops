import { describe, expect, it, vi } from 'vitest';
import { type TaskLogEvent, eventBus } from '../src/events/event-bus.js';

const sample = (event: string): TaskLogEvent => ({
  event,
  message: 'hello',
  at: new Date().toISOString(),
});

describe('EventBus', () => {
  it('delivers events only to subscribers of the same task', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = eventBus.subscribe('task-a', a);
    const unsubB = eventBus.subscribe('task-b', b);

    eventBus.publish('task-a', sample('e1'));

    expect(a).toHaveBeenCalledOnce();
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ event: 'e1' }));
    expect(b).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it('supports multiple subscribers on the same task', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const u1 = eventBus.subscribe('task-multi', l1);
    const u2 = eventBus.subscribe('task-multi', l2);

    eventBus.publish('task-multi', sample('e2'));

    expect(l1).toHaveBeenCalledOnce();
    expect(l2).toHaveBeenCalledOnce();

    u1();
    u2();
  });

  it('unsubscribe stops further delivery for that listener only', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const u1 = eventBus.subscribe('task-unsub', l1);
    const u2 = eventBus.subscribe('task-unsub', l2);

    u1();
    eventBus.publish('task-unsub', sample('e3'));

    expect(l1).not.toHaveBeenCalled();
    expect(l2).toHaveBeenCalledOnce();

    u2();
  });

  it('publishing to a task with no subscribers is a no-op', () => {
    expect(() => eventBus.publish('lonely-task', sample('e4'))).not.toThrow();
  });
});
