import { describe, expect, it, vi } from 'vitest';

const runEeatInterviewerMock = vi.fn();
const runArticleWriterMock = vi.fn();

vi.mock('../src/agents/builtin/eeat-interviewer/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, runEeatInterviewer: runEeatInterviewerMock };
});
vi.mock('../src/agents/builtin/article-writer/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, runArticleWriter: runArticleWriterMock };
});
vi.mock('../src/agents/lib/packs.js', () => ({
  loadPacks: vi.fn(async () => ''),
}));
vi.mock('../src/integrations/shopify/tools.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    buildShopifyTools: vi.fn(async () => [
      { id: 'shopify.publish_article', tool: { name: 'publish_article' } },
    ]),
  };
});

const { seoArticleWithEeatAgent } = await import(
  '../src/agents/builtin/seo-article-with-eeat/index.js'
);

function makeCtx() {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    systemPrompt: '',
    agentConfig: { eeatEnabled: true, publishToShopify: true, skills: {} },
    availableExecutionAgents: [],
    tenantProfile: {
      tenantId: '...',
      industry: null,
      brandVoice: null,
      profileMd: null,
      imageStyleSuffix: null,
      timezone: 'UTC',
    },
    logCtx: { taskId: 'x', agentId: 'seo-article-with-eeat' },
    emitLog: vi.fn(async () => {}),
  } as never;
}

const STUB_INTERVIEWER_OUT = {
  message: 'Q?',
  awaitingApproval: true,
  artifact: { report: '## 我需要先請你回答幾個問題\n\n...' },
  payload: { eeatPending: { questions: [], askedAt: 'x' } },
  structuredOutput: {
    schemaName: 'eeat-questions',
    data: { questions: [], askedAt: 'x' },
  },
};
const STUB_ARTICLE_OUT = {
  message: 'Draft done.',
  awaitingApproval: true,
  artifact: { body: '# Article', refs: { title: 'X' } },
  structuredOutput: {
    schemaName: 'article-draft',
    data: { title: 'X' },
    keyDecisions: ['k1'],
  },
  pendingToolCall: { id: 'shopify.publish_article', args: { title: 'X' } },
};

describe('seo-article-with-eeat — router decisions', () => {
  it('Path 1: eeatEnabled=false → article-writer (skips interviewer)', async () => {
    runEeatInterviewerMock.mockReset();
    runArticleWriterMock.mockReset();
    runArticleWriterMock.mockResolvedValueOnce(STUB_ARTICLE_OUT);
    const ctx = makeCtx() as unknown as { agentConfig: Record<string, unknown> };
    ctx.agentConfig = { eeatEnabled: false, publishToShopify: true, skills: {} };
    const runnable = await seoArticleWithEeatAgent.build(ctx as never);

    const out = await runnable.invoke({
      messages: [{ role: 'user', content: 'write linen guide' }],
      params: {},
    });

    expect(runEeatInterviewerMock).not.toHaveBeenCalled();
    expect(runArticleWriterMock).toHaveBeenCalledTimes(1);
    expect(out.structuredOutput?.schemaName).toBe('article-draft');
  });

  it('Path 2: eeatEnabled=true + no eeatPending → eeat-interviewer', async () => {
    runEeatInterviewerMock.mockReset();
    runArticleWriterMock.mockReset();
    runEeatInterviewerMock.mockResolvedValueOnce(STUB_INTERVIEWER_OUT);
    const runnable = await seoArticleWithEeatAgent.build(makeCtx());

    const out = await runnable.invoke({
      messages: [{ role: 'user', content: 'write linen guide' }],
      params: {},
    });

    expect(runEeatInterviewerMock).toHaveBeenCalledTimes(1);
    expect(runArticleWriterMock).not.toHaveBeenCalled();
    expect(out.structuredOutput?.schemaName).toBe('eeat-questions');
    expect(out.payload?.eeatPending).toBeDefined();
  });

  it('Path 3: eeatPending set + last message from user → article-writer', async () => {
    runEeatInterviewerMock.mockReset();
    runArticleWriterMock.mockReset();
    runArticleWriterMock.mockResolvedValueOnce(STUB_ARTICLE_OUT);
    const runnable = await seoArticleWithEeatAgent.build(makeCtx());

    const out = await runnable.invoke({
      messages: [
        { role: 'user', content: 'write linen guide' },
        { role: 'assistant', content: 'EEAT questions...' },
        { role: 'user', content: 'My answers: washed 10 times.' },
      ],
      params: {},
      taskOutput: { eeatPending: { questions: [], askedAt: 'x' } },
    });

    expect(runEeatInterviewerMock).not.toHaveBeenCalled();
    expect(runArticleWriterMock).toHaveBeenCalledTimes(1);
    expect(out.structuredOutput?.schemaName).toBe('article-draft');
  });

  it('Path 4: eeatPending set but last message NOT from user → article-writer fallback', async () => {
    runEeatInterviewerMock.mockReset();
    runArticleWriterMock.mockReset();
    runArticleWriterMock.mockResolvedValueOnce(STUB_ARTICLE_OUT);
    const runnable = await seoArticleWithEeatAgent.build(makeCtx());

    const out = await runnable.invoke({
      messages: [
        { role: 'user', content: 'write linen guide' },
        { role: 'assistant', content: 'EEAT questions...' },
      ],
      params: {},
      taskOutput: { eeatPending: { questions: [], askedAt: 'x' } },
    });

    expect(runEeatInterviewerMock).not.toHaveBeenCalled();
    expect(runArticleWriterMock).toHaveBeenCalledTimes(1);
    expect(out.structuredOutput?.schemaName).toBe('article-draft');
  });
});
