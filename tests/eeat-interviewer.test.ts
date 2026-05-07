import { describe, expect, it, vi } from 'vitest';

const invokeStructuredMock = vi.fn();
vi.mock('../src/agents/lib/invoke-structured.js', () => ({
  invokeStructured: invokeStructuredMock,
}));

vi.mock('../src/agents/lib/packs.js', () => ({
  loadPacks: vi.fn(async () => ''),
}));

const { eeatInterviewerAgent } = await import('../src/agents/builtin/eeat-interviewer/index.js');

function makeCtx() {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    systemPrompt: 'You are an interviewer.',
    agentConfig: { skills: {} },
    availableExecutionAgents: [],
    tenantProfile: {
      tenantId: '...',
      industry: null,
      brandVoice: null,
      profileMd: null,
      imageStyleSuffix: null,
      timezone: 'UTC',
    },
    logCtx: { taskId: 'x', agentId: 'eeat-interviewer' },
    emitLog: vi.fn(async () => {}),
  } as never;
}

describe('eeat-interviewer — invoke contract', () => {
  it('asks 1–5 questions, sets awaitingApproval, eeatPending, and lastStructuredOutput.schemaName=eeat-questions', async () => {
    invokeStructuredMock.mockResolvedValueOnce({
      questions: [
        {
          question: 'How many washes before pilling?',
          hint: 'Specific number please.',
          optional: false,
        },
        { question: 'Have you worn it in Taiwan summer humidity?', optional: true },
      ],
      narrative: '## 為什麼需要你的親身經驗\n\n搜尋者愛看真實數字。',
      progressNote: '有幾個 EEAT 問題想先請老闆回答。',
    });

    const runnable = await eeatInterviewerAgent.build(makeCtx());
    const out = await runnable.invoke({
      messages: [{ role: 'user', content: '幫我寫一篇亞麻襯衫指南' }],
      params: {},
    });

    expect(out.awaitingApproval).toBe(true);
    expect(out.payload?.eeatPending).toMatchObject({
      questions: expect.arrayContaining([
        expect.objectContaining({ question: expect.any(String) }),
      ]),
      askedAt: expect.any(String),
    });
    expect(out.artifact?.report).toMatch(/我需要先請你回答幾個問題|EEAT|親身經驗/);
    expect(out.structuredOutput).toMatchObject({
      schemaName: 'eeat-questions',
      data: expect.objectContaining({
        questions: expect.any(Array),
        askedAt: expect.any(String),
      }),
    });
  });
});
