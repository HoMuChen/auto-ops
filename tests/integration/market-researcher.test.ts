import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import {
  clearScript,
  llmMockModule,
  scriptStructured,
  scriptText,
  scriptToolCall,
} from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

const { createTestApp } = await import('./helpers/app.js');
const { getTask } = await import('../../src/tasks/repository.js');

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await truncateAll();
  clearScript();
});

describe('market-researcher atomic agent — direct routing + report-writer rendering', () => {
  it('researches → report-writer renders prose → done; structuredOutput persisted', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await app.inject({
      method: 'POST',
      url: '/v1/agents/market-researcher/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: {} },
    });

    // Hop 1: supervisor → market-researcher.
    scriptStructured({ nextAgent: 'market-researcher', clarification: null, done: false });

    // Hop 2: agent invokes its tool loop and submits the report. Body must
    // clear the agent's ReportSchema body.min(300) gate.
    const reportBody = `## 市場概況

寵物用品市場規模約新台幣 350 億，年成長 6%（2024 → 2026）。
地理上以雙北、桃園消費密度最高，南部以台中、高雄為次集中區，
線上滲透率 32%。整體呈現高端鮮食 + 中低價乾糧兩極分化。

## 主要競品

- **A 牌**：中價位主食罐主導，成分透明但社群弱。
- **B 牌**：低價乾糧，超市通路強，網購弱，價格戰主軸。
- **C 牌**：高價手作鮮食，社群佳但物流痛點明顯，常被抱怨配送破損。
- **D 牌**：訂閱模型，自動續約 + 會員價，高黏著但 SKU 少。

## 市場缺口

中價位且具設計感的訂閱式鮮食方案，目前明顯空白。
中型犬齡 7+ 的關節保健食品線，本土品牌幾乎沒人做，依賴進口品。

## 消費者趨勢

養寵物高齡化，飼主開始重視關節與心血管保健配方。
社群上「人寵共食」標籤年增 180%。

## 切入建議

中價位訂閱鮮食 + 機能配方為主打，避開低價乾糧紅海。
雙北採實體快閃 + 線上會員雙軌，跨足社群 KOC 行銷。`;

    scriptToolCall('submit_report', {
      body: reportBody,
      sources: ['https://example.com/pet-market-2026', 'https://example.com/competitor-c-review'],
      keyDecisions: ['聚焦中價位設計感缺口', '避開低價乾糧紅海', '高齡寵物保健是空白市場'],
      progressNote: '報告好了，最大缺口是中價位設計感商品，老闆看一下切入建議',
    });

    // Note: no second supervisor scriptStructured — once market-researcher sets
    // awaitingApproval=true, runSupervisor short-circuits without an LLM call,
    // so the graph routes straight from supervisor → report-writer.

    // Hop 3: report-writer LLM call — renders boss prose for schemaName='market-report'.
    scriptText(
      '## 我看到的重點\n\n中價位設計感商品是這個品類最大的空白。\n\n## 為什麼這樣選\n\n低價乾糧已是紅海，高價手作有物流痛點。',
    );

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: '幫我研究台灣寵物用品市場' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    const task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('market-researcher');
    expect(task.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer, contains the prose it
        // generated — NOT a verbatim copy of structuredOutput.data.body.
        report: expect.stringContaining('我看到的重點'),
        body: expect.stringContaining('## 市場概況'),
        refs: expect.objectContaining({
          sources: expect.arrayContaining(['https://example.com/pet-market-2026']),
          sourceCount: 2,
        }),
      },
      lastStructuredOutput: {
        schemaName: 'market-report',
        data: expect.objectContaining({
          body: expect.stringContaining('## 市場概況'),
          sources: expect.arrayContaining(['https://example.com/pet-market-2026']),
        }),
        keyDecisions: expect.arrayContaining(['聚焦中價位設計感缺口']),
      },
    });
    // Researcher is plain-text deliverable — no pending tool call.
    expect(task.output).not.toHaveProperty('pendingToolCall');
  });
});
