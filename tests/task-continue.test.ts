import { describe, expect, it } from 'vitest';
import type { Task } from '../src/db/schema/index.js';
import { buildContinuation } from '../src/tasks/continue.js';

function fakeTask(overrides: Partial<Task>): Task {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: '00000000-0000-0000-0000-000000000001',
    parentTaskId: null,
    title: 'fake',
    description: 'fake',
    kind: 'execution',
    assignedAgent: null,
    threadId: null,
    status: 'done',
    input: {},
    output: {},
    error: null,
    scheduledAt: null,
    completedAt: new Date('2026-05-04T10:00:00.000Z'),
    lockedBy: null,
    lockExpiresAt: null,
    createdBy: null,
    createdAt: new Date('2026-05-04T09:00:00.000Z'),
    updatedAt: new Date('2026-05-04T10:00:00.000Z'),
    ...overrides,
  } as Task;
}

describe('buildContinuation', () => {
  it('threads the prior artifact.report into a synthesized brief above the follow-up', () => {
    const prior = fakeTask({
      output: { artifact: { report: '## 市場概況\n\n寵物用品市場規模約 350 億。' } },
    });
    const { synthesizedBrief, priorReport } = buildContinuation(prior, '幫我規劃 3 篇 SEO 文章');

    expect(priorReport).toBe('## 市場概況\n\n寵物用品市場規模約 350 億。');
    expect(synthesizedBrief).toContain('（接續自先前任務 11111111-1111-1111-1111-111111111111）');
    expect(synthesizedBrief).toContain('## 市場概況');
    expect(synthesizedBrief).toContain('請接著處理：幫我規劃 3 篇 SEO 文章');
    // The prior context block must come BEFORE the follow-up brief so
    // supervisor reads it as established context, not as a follow-up topic.
    const ctxIdx = synthesizedBrief.indexOf('## 市場概況');
    const followIdx = synthesizedBrief.indexOf('請接著處理');
    expect(ctxIdx).toBeLessThan(followIdx);
  });

  it('throws when the prior task is not done', () => {
    for (const status of ['todo', 'in_progress', 'waiting', 'failed'] as const) {
      const prior = fakeTask({ status, output: { artifact: { report: 'x' } } });
      expect(() => buildContinuation(prior, 'follow-up')).toThrow(/expected done/);
    }
  });

  it('throws when the prior task has no artifact.report to thread forward', () => {
    expect(() => buildContinuation(fakeTask({ output: {} }), 'follow-up')).toThrow(
      /no artifact\.report/,
    );
    expect(() =>
      buildContinuation(fakeTask({ output: { artifact: { report: '' } } }), 'follow-up'),
    ).toThrow(/no artifact\.report/);
  });
});
