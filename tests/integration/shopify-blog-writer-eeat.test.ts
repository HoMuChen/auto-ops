/**
 * Tests the two-stage EEAT flow:
 *   Stage 1 — writer asks EEAT experience questions (when params.refs.primaryKeyword
 *             is present, i.e. the task was spawned by the SEO Strategist)
 *   Stage 2 — writer drafts the article after boss replies
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import { clearScript, llmMockModule, scriptStructured } from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { createTestApp } = await import('./helpers/app.js');
const { getTask } = await import('../../src/tasks/repository.js');
const { db } = await import('../../src/db/client.js');
const { tenantCredentials } = await import('../../src/db/schema/index.js');

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
  fetchMock.mockReset();
});

describe('Shopify Blog Writer EEAT two-stage flow', () => {
  it('Stage 1: asks EEAT questions → Stage 2: drafts article → approve → publish', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_test',
      metadata: { storeUrl: 'demo-shop.myshopify.com' },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-blog-writer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { targetLanguages: ['zh-TW'], publishToShopify: true } },
    });

    // Supervisor routes to writer; Stage 1 — writer asks EEAT questions
    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptStructured({
      questions: [
        {
          question: 'How many times have you washed this linen shirt before pilling started?',
          hint: 'Specific numbers build credibility.',
          optional: false,
        },
        {
          question: 'Have you worn it in Taiwan summer humidity? How did it feel?',
          optional: true,
        },
      ],
      narrative:
        '## 為什麼需要老闆親身經驗\n\n亞麻保養與穿著體驗是 EEAT 加分項，網路一般文章寫不出來。把你的真實數字放進文章開頭，搜尋者一看就知道我們是真懂。',
      progressNote: '有幾個 EEAT 問題想先請老闆確認，這樣文章會更有說服力',
    });

    // Create the task with refs.primaryKeyword (signals it came from Strategist).
    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: {
        brief: '幫我寫一篇亞麻襯衫夏天穿著指南',
        // Params injected as if spawned by the Strategist with the new shape.
        params: {
          refs: {
            primaryKeyword: '亞麻襯衫 夏天',
            language: 'zh-TW',
          },
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    // Phase 1: drain → Stage 1 fires → task waiting with eeatPending and report artifact
    await drainNextTask();
    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('我需要先請你回答幾個問題'),
        refs: { askedAt: expect.any(String) },
      },
      eeatPending: {
        questions: expect.arrayContaining([
          expect.objectContaining({ question: expect.any(String) }),
        ]),
        askedAt: expect.any(String),
      },
    });
    expect(task.output).not.toHaveProperty('pendingToolCall');
    // Stage 1 artifact: flat shape, no `kind` discriminant
    expect(task.output).not.toMatchObject({
      artifact: { kind: expect.anything() },
    });

    // Check that the assistant message contains the question text
    const msgs1 = await app
      .inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/messages`,
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    expect(msgs1.some((m: { content: string }) => m.content.includes('EEAT'))).toBe(true);

    // Phase 2: boss replies with answers
    const feedback = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/feedback`,
      headers: authHeaders(jwt, tenantId),
      payload: { feedback: '洗了大概 10 次，完全沒起球。台北 35 度穿，涼到不像麻。' },
    });
    expect(feedback.statusCode).toBe(200);
    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('todo');

    // Script Stage 2 article (markdown body + report)
    scriptStructured({
      title: '亞麻襯衫夏天穿著指南：親身體驗告訴你為什麼值得',
      body: '## 為什麼亞麻是夏天最好的材質\n\n洗了 10 次不起球，穿在台北 35 度感覺涼到不像麻。\n\n- 機能：透氣、抗皺\n- 保養：少水機洗\n- 搭配：白色為基底',
      summaryHtml: '完整亞麻襯衫選購與保養指南，附親身使用心得。',
      tags: ['亞麻', '夏季穿搭', '永續材質'],
      language: 'zh-TW',
      report:
        '## 切角\n\n用老闆「洗 10 次不起球」這個具體數字當開頭，把 EEAT 寫在最前面。Boss 的實穿經驗是這篇與其他通泛文章的差異化。',
      progressNote: '草稿好了，開頭我用了老闆親身體驗的數字，應該很有說服力',
    });

    // Phase 3: drain → Stage 2 fires → task waiting with pendingToolCall
    await drainNextTask();
    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('切角'),
        body: expect.stringContaining('## 為什麼亞麻'),
        refs: expect.objectContaining({
          title: expect.stringContaining('亞麻'),
          language: 'zh-TW',
          tags: expect.arrayContaining(['亞麻']),
        }),
      },
      pendingToolCall: {
        id: 'shopify.publish_article',
        // bodyHtml is markdownToHtml(body) — converted at the publish boundary.
        args: expect.objectContaining({
          bodyHtml: expect.stringContaining('<h2>為什麼亞麻是夏天最好的材質</h2>'),
        }),
      },
    });
    // Stage 2 artifact: flat shape too — no `kind`/`data`.
    expect(task.output).not.toMatchObject({
      artifact: { kind: expect.anything() },
    });

    // Phase 4: approve → publish_article fires
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ blogs: [{ id: 100, handle: 'news', title: 'News' }] }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => '',
        json: async () => ({
          article: { id: 5000, handle: 'linen-summer', blog_id: 100, published_at: null },
        }),
      } as unknown as Response);

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('done');
    // tool-executor leaves the new flat artifact untouched — publish metadata
    // lives only in the task log line, not stamped on artifact.refs.
    expect(task.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('切角'),
        body: expect.stringContaining('## 為什麼亞麻'),
        refs: expect.objectContaining({ title: expect.stringContaining('亞麻') }),
      },
      toolExecutedAt: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
