import { describe, expect, it, vi } from 'vitest';

/**
 * Market Researcher: verifies the report-only deliverable shape — the agent
 * runs serper + web_fetch (mocked away here), submits a structured report,
 * and surfaces it as an Artifact{report,refs.sources}. No spawn, no
 * pendingToolCall — pure plain-text deliverable that gates on awaitingApproval.
 */

const reportFixture = {
  report: `## 市場概況

寵物用品市場規模約新台幣 350 億，年成長 6%（2024 → 2026）。
地理上以雙北、桃園消費密度最高，南部以台中、高雄為次集中區，
線上滲透率 32%。整體呈現高端鮮食 + 中低價乾糧兩極分化。

## 主要競品

- **A 牌**：中價位主食罐主導，主打成分透明，無補貼貨架但社群弱。
- **B 牌**：低價乾糧，超市通路強，網購弱，價格戰主軸。
- **C 牌**：高價手作鮮食，社群經營佳但物流痛點明顯，常被抱怨配送破損。
- **D 牌**：訂閱模型 (subscribe & save)，自動續約 + 會員價，高黏著但 SKU 少。

## 市場缺口

中價位且具設計感的訂閱式鮮食方案，目前明顯空白。
中型犬齡 7+ 的關節保健食品線，本土品牌幾乎沒人做，依賴進口品。

## 消費者趨勢

養寵物高齡化（飼主平均 38 歲，寵物平均 6.2 歲），
飼主開始重視關節與心血管保健配方。社群上「人寵共食」標籤年增 180%。

## 切入建議

1. 中價位訂閱鮮食 + 機能配方為主打，避開最內卷的 100-300 元乾糧紅海。
2. 雙北通路採實體品牌快閃 + 線上會員雙軌，跨足社群 KOC 行銷。
3. SKU 聚焦 8-12 項，做深不做廣，前 6 個月不擴品類。`,
  sources: ['https://example.com/pet-market-2026', 'https://example.com/competitor-c-review'],
  progressNote: '報告好了，這個品類最大缺口是中價位設計感商品，老闆看一下切入建議',
};

const toolPassInvokeMock = vi.fn();
toolPassInvokeMock.mockResolvedValue({
  content: '',
  tool_calls: [{ id: 'call_submit_1', name: 'submit_report', args: reportFixture }],
});
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
  })),
}));

const { marketResearcherAgent } = await import('../src/agents/builtin/market-researcher/index.js');

describe('marketResearcherAgent.build → invoke', () => {
  const ctx = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: marketResearcherAgent.manifest.defaultModel,
    systemPrompt: marketResearcherAgent.manifest.defaultPrompt,
    agentConfig: {},
    availableExecutionAgents: [],
    emitLog: vi.fn(
      async (_event: string, _message: string, _data?: Record<string, unknown>) => {},
    ),
  };

  it('returns a markdown report artifact with sources in refs and gates on approval', async () => {
    const runnable = await marketResearcherAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: '幫我研究寵物用品在台灣的市場' }],
      params: {},
    });

    expect(result.awaitingApproval).toBe(true);
    expect(result.spawnTasks).toBeUndefined();
    expect(result.pendingToolCall).toBeUndefined();
    expect(result.artifact?.report).toContain('## 市場概況');
    expect(result.artifact?.report).toContain('## 切入建議');
    expect(result.artifact?.refs).toEqual({
      sources: reportFixture.sources,
      sourceCount: 2,
    });
  });

  it('uses the LLM-produced progressNote as the agent.report.ready timeline message', async () => {
    const emitLog = vi.fn(
      async (_event: string, _message: string, _data?: Record<string, unknown>) => {},
    );
    const runnable = await marketResearcherAgent.build({ ...ctx, emitLog });
    await runnable.invoke({
      messages: [{ role: 'user', content: '研究' }],
      params: {},
    });

    const readyCall = emitLog.mock.calls.find((c) => c[0] === 'agent.report.ready');
    expect(readyCall?.[1]).toBe(reportFixture.progressNote);
  });

  it('contributes no tools — researcher is read-only and never gates on a write', async () => {
    const runnable = await marketResearcherAgent.build(ctx);
    expect(runnable.tools).toEqual([]);
  });

  it('honours configured defaultLanguage and searchLocale via tenant constraints', async () => {
    const runnable = await marketResearcherAgent.build({
      ...ctx,
      agentConfig: { defaultLanguage: 'en', searchLocale: 'us' },
    });
    await runnable.invoke({
      messages: [{ role: 'user', content: 'research US pet market' }],
      params: {},
    });
    const calls = toolPassInvokeMock.mock.calls as unknown as Array<Array<unknown>>;
    const lastCall = calls[calls.length - 1];
    const lastCallArgs = lastCall?.[0] as { content?: string }[] | undefined;
    const systemMsg = lastCallArgs?.find((m) => 'content' in m);
    const text = JSON.stringify(systemMsg);
    expect(text).toContain('Output language: en');
    expect(text).toContain('Default search locale: us');
  });
});
