import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '../src/db/schema/index.js';
import { IllegalStateError } from '../src/lib/errors.js';
import { assertTransition, canTransition } from '../src/tasks/state-machine.js';

describe('canTransition', () => {
  it('allows todo → in_progress', () => {
    expect(canTransition('todo', 'in_progress')).toBe(true);
  });

  it('allows in_progress → waiting / done / failed / todo (retry)', () => {
    for (const to of ['waiting', 'done', 'failed', 'todo'] as const) {
      expect(canTransition('in_progress', to)).toBe(true);
    }
  });

  it('allows waiting → in_progress / done / failed', () => {
    for (const to of ['in_progress', 'done', 'failed'] as const) {
      expect(canTransition('waiting', to)).toBe(true);
    }
  });

  it('treats done as terminal', () => {
    for (const to of ['todo', 'in_progress', 'waiting', 'failed'] as const) {
      expect(canTransition('done', to)).toBe(false);
    }
  });

  it('allows failed → todo for manual retry, but no other transition out', () => {
    expect(canTransition('failed', 'todo')).toBe(true);
    for (const to of ['in_progress', 'waiting', 'done'] as const) {
      expect(canTransition('failed', to)).toBe(false);
    }
  });

  it('rejects illegal jumps like todo → done', () => {
    expect(canTransition('todo', 'done')).toBe(false);
    expect(canTransition('todo', 'waiting')).toBe(false);
  });
});

describe('assertTransition', () => {
  it('returns void on legal transitions', () => {
    expect(() => assertTransition('todo', 'in_progress')).not.toThrow();
  });

  it('throws IllegalStateError on illegal transitions', () => {
    expect(() => assertTransition('done', 'todo')).toThrow(IllegalStateError);
  });

  it('error message names the from/to states', () => {
    try {
      assertTransition('done' as TaskStatus, 'in_progress' as TaskStatus);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalStateError);
      expect((err as IllegalStateError).message).toMatch(/done/);
      expect((err as IllegalStateError).message).toMatch(/in_progress/);
    }
  });
});
