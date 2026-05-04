import { describe, expect, it } from 'vitest';
import type { Task } from '../src/db/schema/index.js';
import { buildDoneEmail } from '../src/notifications/email.js';
import { decideDoneRecipient } from '../src/notifications/recipient.js';

describe('decideDoneRecipient', () => {
  const userEmail = 'boss@example.com';

  it('returns null when override is unset and global setting is off', () => {
    expect(
      decideDoneRecipient({ notifyOverride: undefined, settings: null, userEmail }),
    ).toBeNull();
    expect(
      decideDoneRecipient({
        notifyOverride: undefined,
        settings: { notifyOnDone: false },
        userEmail,
      }),
    ).toBeNull();
  });

  it('returns the user email when global setting opts in and no override', () => {
    expect(
      decideDoneRecipient({
        notifyOverride: undefined,
        settings: { notifyOnDone: true },
        userEmail,
      }),
    ).toBe(userEmail);
  });

  it('per-task override true overrides global off', () => {
    expect(
      decideDoneRecipient({ notifyOverride: true, settings: null, userEmail }),
    ).toBe(userEmail);
    expect(
      decideDoneRecipient({
        notifyOverride: true,
        settings: { notifyOnDone: false },
        userEmail,
      }),
    ).toBe(userEmail);
  });

  it('per-task override false overrides global on (explicit opt-out)', () => {
    expect(
      decideDoneRecipient({
        notifyOverride: false,
        settings: { notifyOnDone: true },
        userEmail,
      }),
    ).toBeNull();
  });

  it('per-task override with explicit email wins over user email', () => {
    expect(
      decideDoneRecipient({
        notifyOverride: { email: 'team@example.com' },
        settings: null,
        userEmail,
      }),
    ).toBe('team@example.com');
  });

  it('per-task override empty object falls back to user email', () => {
    expect(
      decideDoneRecipient({ notifyOverride: {}, settings: null, userEmail }),
    ).toBe(userEmail);
  });

  it('returns null when there is genuinely no recipient available', () => {
    expect(
      decideDoneRecipient({
        notifyOverride: true,
        settings: null,
        userEmail: null,
      }),
    ).toBeNull();
  });
});

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: '00000000-0000-0000-0000-000000000001',
    parentTaskId: null,
    title: '寵物用品市場研究',
    description: null,
    kind: 'execution',
    assignedAgent: null,
    threadId: null,
    status: 'done',
    input: {},
    output: { artifact: { report: '## 市場概況\n\n概要…' } },
    error: null,
    scheduledAt: null,
    completedAt: new Date(),
    lockedBy: null,
    lockExpiresAt: null,
    createdBy: '22222222-2222-2222-2222-222222222222',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

describe('buildDoneEmail', () => {
  it('subject leads with the title and a checkmark', () => {
    const { subject } = buildDoneEmail(fakeTask());
    expect(subject).toBe('✓ 寵物用品市場研究');
  });

  it('text body embeds the artifact.report so the recipient sees the deliverable inline', () => {
    const { text } = buildDoneEmail(fakeTask());
    expect(text).toContain('任務「寵物用品市場研究」已完成');
    expect(text).toContain('## 市場概況');
  });

  it('html escapes the title (string field embedded in non-markdown wrapper)', () => {
    const { html } = buildDoneEmail(
      fakeTask({ title: 'evil <script>alert(1)</script>', output: {} }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the markdown report through marked (## headings → <h2>, - bullets → <ul>)', () => {
    const { html } = buildDoneEmail(
      fakeTask({
        output: {
          artifact: {
            report: '## 市場概況\n\n- 第一點\n- 第二點\n\n**強調**',
          },
        },
      }),
    );
    expect(html).toContain('<h2>市場概況</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>第一點</li>');
    expect(html).toContain('<strong>強調</strong>');
  });

  it('falls back to a placeholder when the task has no artifact.report', () => {
    const { text, html } = buildDoneEmail(fakeTask({ output: {} }));
    expect(text).toContain('沒有產出 report 內容');
    expect(html).toContain('沒有產出 report 內容');
  });
});
