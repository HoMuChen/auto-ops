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
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn(async () => ({})) })),
  PutObjectCommand: vi.fn(),
}));

process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key';
process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL = 'https://assets.example.com';
process.env.OPENAI_API_KEY = 'sk-test';
const { clearEnvCache } = await import('../../src/config/env.js');
clearEnvCache();

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

describe('seo-article-with-eeat workflow — EEAT → article → publish', () => {
  it('Hop 1 asks EEAT (no report-writer rendering); Hop 2 writes article (rendered)', async () => {
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
      url: '/v1/agents/seo-article-with-eeat/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: { eeatEnabled: true, publishToShopify: true, skills: { eeat: true } },
      },
    });

    // Hop 1: supervisor → workflow → eeat-interviewer.
    scriptStructured({ nextAgent: 'seo-article-with-eeat', clarification: null, done: false });
    scriptStructured({
      // EEAT questions.
      questions: [
        { question: 'How many washes before pilling?', optional: false },
        { question: 'Worn in Taipei summer humidity?', optional: true },
      ],
      narrative: '## 為什麼需要老闆親身經驗\n\n網路一般文章寫不出來。',
      progressNote: '有幾個 EEAT 問題想先請老闆確認。',
    });
    // No report-writer LLM call — schemaName='eeat-questions' is in skip set.

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: '幫我寫一篇亞麻襯衫夏天指南' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('seo-article-with-eeat');
    expect(task.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('我需要先請你回答幾個問題'),
        refs: { askedAt: expect.any(String) },
      },
      eeatPending: { questions: expect.any(Array), askedAt: expect.any(String) },
      lastStructuredOutput: {
        schemaName: 'eeat-questions',
        data: expect.objectContaining({ questions: expect.any(Array) }),
      },
    });

    // Hop 2: boss replies, then workflow → article-writer.
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/feedback`,
      headers: authHeaders(jwt, tenantId),
      payload: { feedback: '洗了 10 次沒起球。台北 35 度穿，涼到不像麻。' },
    });
    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('todo');

    scriptToolCall('submit_article', {
      title: '亞麻襯衫夏天指南',
      slug: 'linen-summer-guide',
      body:
        '## 為什麼亞麻贏夏天\n\n老闆親身體驗：洗 10 次完全沒起球，台北 35 度穿起來涼到不像麻。' +
        '這篇我們從機能性切入，避開純穿搭潮流的泛論。',
      summaryHtml: '完整亞麻襯衫指南，附老闆親身使用心得與穿著數字，台灣夏天必備。',
      tags: ['亞麻'],
      language: 'zh-TW',
      author: null,
      keyDecisions: ['用「洗 10 次不起球」當開頭', 'EEAT 寫在最前面'],
      progressNote: '草稿好了，開頭用了老闆親身體驗的數字。',
    });
    scriptText(
      '## 切角\n\n用老闆「洗 10 次不起球」這個具體數字當開頭，把 EEAT 寫在最前面。',
    );

    await drainNextTask();
    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('seo-article-with-eeat');
    expect(task.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('切角'),
        body: expect.stringContaining('## 為什麼亞麻贏夏天'),
        refs: expect.objectContaining({ language: 'zh-TW' }),
      },
      lastStructuredOutput: {
        schemaName: 'article-draft',
        data: expect.objectContaining({ title: '亞麻襯衫夏天指南' }),
      },
      pendingToolCall: { id: 'shopify.publish_article' },
    });

    // Approve → publish.
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
          article: { id: 5000, handle: 'linen-summer-guide', blog_id: 100, published_at: null },
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('eeatEnabled=false → workflow goes straight to article-writer (single hop)', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_x',
      metadata: { storeUrl: 'demo-shop.myshopify.com' },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/agents/seo-article-with-eeat/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { eeatEnabled: false, publishToShopify: true, skills: {} } },
    });

    scriptStructured({ nextAgent: 'seo-article-with-eeat', clarification: null, done: false });
    scriptToolCall('submit_article', {
      title: 'Skip EEAT article',
      slug: 'skip-eeat-article',
      body: '## Body\n\nLong enough body content here for the schema minimum.',
      summaryHtml: 'A short summary that meets schema minimum.',
      tags: ['demo'],
      language: 'en',
      author: null,
      keyDecisions: ['Skip EEAT per config.'],
      progressNote: 'Draft done.',
    });
    scriptText('## 切角\n\nDirect path, no EEAT.');

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'write something quickly' },
    });
    const taskId = create.json().id as string;
    await drainNextTask();

    const task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('seo-article-with-eeat');
    expect(task.output).not.toHaveProperty('eeatPending');
    expect(task.output).toMatchObject({
      artifact: { report: expect.stringContaining('切角'), body: expect.stringContaining('Body') },
      lastStructuredOutput: { schemaName: 'article-draft' },
      pendingToolCall: { id: 'shopify.publish_article' },
    });
  });
});
