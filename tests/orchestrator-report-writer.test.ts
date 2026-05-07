import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const buildModelMock = vi.fn(() => ({
  invoke: invokeMock,
}));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: buildModelMock,
}));

const { runReportWriter } = await import('../src/orchestrator/report-writer.js');

beforeEach(() => {
  invokeMock.mockReset();
  buildModelMock.mockClear();
});

describe('runReportWriter — no-op paths', () => {
  it('returns an empty patch when lastStructuredOutput is null', async () => {
    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [],
      params: {},
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: null,
      lastStructuredOutput: null,
      awaitingApproval: false,
      currentTaskOutput: null,
      taskImageIds: null,
    };

    const result = await runReportWriter(state);

    expect(result).toEqual({});
    expect(buildModelMock).not.toHaveBeenCalled();
  });

  it('returns an empty patch when schemaName is in REPORT_SKIP_SCHEMAS (eeat-questions)', async () => {
    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [],
      params: {},
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: {
        agentId: 'eeat-interviewer',
        message: 'asked questions',
        artifact: { report: 'existing question prompt — must be preserved' },
      },
      lastStructuredOutput: {
        agentId: 'eeat-interviewer',
        schemaName: 'eeat-questions',
        data: { questions: [{ question: 'How long have you worn linen?' }] },
      },
      awaitingApproval: true,
      currentTaskOutput: null,
      taskImageIds: null,
    };

    const result = await runReportWriter(state);

    expect(result).toEqual({});
    expect(buildModelMock).not.toHaveBeenCalled();
  });
});

describe('runReportWriter — LLM rendering', () => {
  it('renders boss-facing markdown into lastOutput.artifact.report for normal schemas', async () => {
    invokeMock.mockResolvedValueOnce(
      new AIMessage('## 切角\n\n從機能性切入...\n\n## EEAT 強化點\n\n用實穿經驗開頭。'),
    );

    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [new HumanMessage('幫我寫一篇 2026 夏季女裝穿搭文')],
      params: {},
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: {
        agentId: 'article-writer',
        message: 'draft done',
        artifact: {
          report: '',
          body: '# Article body markdown',
          refs: { title: 'Summer linen', slug: 'summer-linen' },
        },
      },
      lastStructuredOutput: {
        agentId: 'article-writer',
        schemaName: 'article-draft',
        data: { title: 'Summer linen', body: '# Article body markdown' },
        keyDecisions: ['用機能性切入', '開頭塞 EEAT 數字'],
      },
      awaitingApproval: true,
      currentTaskOutput: null,
      taskImageIds: null,
    };

    const result = await runReportWriter(state);

    expect(buildModelMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.lastOutput?.artifact?.report).toContain('切角');
    // body and refs must be preserved from the input state.
    expect(result.lastOutput?.artifact?.body).toBe('# Article body markdown');
    expect(result.lastOutput?.artifact?.refs).toEqual({
      title: 'Summer linen',
      slug: 'summer-linen',
    });
    // agentId / message must also survive intact.
    expect(result.lastOutput?.agentId).toBe('article-writer');
    expect(result.lastOutput?.message).toBe('draft done');
  });
});

describe('runReportWriter — error handling', () => {
  it('returns a fallback report and does not throw when the LLM rejects', async () => {
    invokeMock.mockRejectedValueOnce(new Error('LLM provider 503'));

    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [new HumanMessage('幫我寫一篇文章')],
      params: {},
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: {
        agentId: 'article-writer',
        message: 'draft done',
        artifact: { report: '', body: '# article', refs: {} },
      },
      lastStructuredOutput: {
        agentId: 'article-writer',
        schemaName: 'article-draft',
        data: { title: 'X' },
      },
      awaitingApproval: true,
      currentTaskOutput: null,
      taskImageIds: null,
    };

    // Must not throw.
    const result = await runReportWriter(state);

    expect(result.lastOutput?.artifact?.report).toBeTruthy();
    expect(result.lastOutput?.artifact?.report).toContain('匯報生成失敗');
    // Body must still be preserved.
    expect(result.lastOutput?.artifact?.body).toBe('# article');
  });
});
