/**
 * Tests the two-stage EEAT flow:
 *   Stage 1 — writer asks EEAT experience questions (when research.eeatHook present)
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
      progressNote: '有幾個 EEAT 問題想先請老闆確認，這樣文章會更有說服力',
    });

    // Create the task with research including eeatHook so Stage 1 fires
    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: {
        brief: '幫我寫一篇亞麻襯衫夏天穿著指南',
        // Params injected as if spawned by the Strategist
        params: {
          research: {
            searchIntent: 'commercial',
            paaQuestions: ['Is linen good for summer?'],
            relatedSearches: ['linen vs cotton'],
            competitorTopAngles: ['fabric guides'],
            competitorGaps: ['no Taiwan humidity advice'],
            targetWordCount: 1200,
            eeatHook: 'Boss should share own washing/wearing experience in tropical humidity.',
          },
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    // Phase 1: drain → Stage 1 fires → task waiting with eeatPending
    await drainNextTask();
    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.output).toMatchObject({
      eeatPending: {
        questions: expect.arrayContaining([
          expect.objectContaining({ question: expect.any(String) }),
        ]),
        askedAt: expect.any(String),
      },
    });
    expect(task.output).not.toHaveProperty('pendingToolCall');

    // Check that the assistant message contains the questions markdown
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

    // Script Stage 2 article
    scriptStructured({
      title: '亞麻襯衫夏天穿著指南：親身體驗告訴你為什麼值得',
      bodyHtml: '<h2>為什麼亞麻是夏天最好的材質</h2><p>洗了 10 次不起球，穿在台北 35 度感覺涼到不像麻。</p>',
      summaryHtml: '完整亞麻襯衫選購與保養指南，附親身使用心得。',
      tags: ['亞麻', '夏季穿搭', '永續材質'],
      language: 'zh-TW',
      progressNote: '草稿好了，開頭我用了老闆親身體驗的數字，應該很有說服力',
    });

    // Phase 3: drain → Stage 2 fires → task waiting with pendingToolCall
    await drainNextTask();
    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.output).toMatchObject({
      article: { title: expect.stringContaining('亞麻') },
      pendingToolCall: { id: 'shopify.publish_article' },
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
    expect(task.output).toMatchObject({
      toolResult: { articleId: 5000, status: 'draft' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
