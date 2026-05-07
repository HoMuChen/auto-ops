import { describe, expect, it, vi } from 'vitest';

const buildModelMock = vi.fn(() => {
  throw new Error('buildModel must not be called when lastStructuredOutput is null');
});
vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: buildModelMock,
}));

const { runReportWriter } = await import('../src/orchestrator/report-writer.js');

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
    buildModelMock.mockClear();
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
