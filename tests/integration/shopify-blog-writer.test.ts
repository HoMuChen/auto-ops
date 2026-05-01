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

describe('Shopify Blog Writer → Shopify Blog publishing', () => {
  it('drafts article → waiting → approve → resolves blog → POSTs article → done', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_test_token',
      metadata: { storeUrl: 'demo-shop.myshopify.com' },
    });

    // Activate writer with a specific blog target so we can assert the resolver
    // picks the right blog (not just the first one).
    const activate = await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-blog-writer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: {
          targetLanguages: ['zh-TW'],
          publishToShopify: true,
          blogHandle: 'editorial',
          defaultAuthor: 'Auto-Ops Bot',
        },
      },
    });
    expect(activate.statusCode).toBe(200);

    // Supervisor → routes to shopify-blog-writer; writer → produces structured article.
    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptStructured({
      title: '夏日穿搭 5 個必備單品',
      bodyHtml:
        '<h2>選對材質讓夏天更舒服</h2><p>今年夏天必備的 5 個單品讓妳在 35 度高溫也能保持優雅。</p>',
      summaryHtml: '5 個夏季必備單品挑選指南，含材質與搭配建議。',
      tags: ['夏季穿搭', '女裝', '購物指南'],
      language: 'zh-TW',
      author: 'Editorial Team',
      progressNote: '草稿好了，這篇我從機能性切入而不是純穿搭，老闆看一下',
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: '幫我寫一篇 2026 夏季女裝穿搭文' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('shopify-blog-writer');
    expect(task.output).toMatchObject({
      article: { title: '夏日穿搭 5 個必備單品', language: 'zh-TW' },
      pendingToolCall: {
        id: 'shopify.publish_article',
        args: expect.objectContaining({
          title: '夏日穿搭 5 個必備單品',
          summaryHtml: expect.stringContaining('挑選指南'),
          tags: expect.arrayContaining(['夏季穿搭']),
          author: 'Editorial Team',
        }),
      },
    });

    // Stub Shopify responses: blog list (find "editorial"), then article create.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          blogs: [
            { id: 100, handle: 'news', title: 'News' },
            { id: 200, handle: 'editorial', title: 'Editorial' },
          ],
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => '',
        json: async () => ({
          article: {
            id: 4242,
            handle: 'xia-ri-chuan-da-5-ge-bi-bei-dan-pin',
            blog_id: 200,
            published_at: null,
          },
        }),
      } as unknown as Response);

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [blogsUrl, blogsInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(blogsUrl)).toBe('https://demo-shop.myshopify.com/admin/api/2024-10/blogs.json');
    expect(blogsInit.method ?? 'GET').toBe('GET');
    expect((blogsInit.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(
      'shpat_test_token',
    );

    const [articleUrl, articleInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(String(articleUrl)).toBe(
      // Resolved to blog id 200 because handle "editorial" was specified.
      'https://demo-shop.myshopify.com/admin/api/2024-10/blogs/200/articles.json',
    );
    expect(articleInit.method).toBe('POST');
    const sentBody = JSON.parse(articleInit.body as string);
    expect(sentBody).toMatchObject({
      article: {
        title: '夏日穿搭 5 個必備單品',
        body_html: expect.stringContaining('夏天'),
        summary_html: expect.stringContaining('挑選指南'),
        // Tags get normalised to comma-separated string in the client.
        tags: expect.stringMatching(/夏季穿搭/),
        author: 'Editorial Team',
        published: false, // publishImmediately=false by default
      },
    });

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('done');
    expect(task.output).toMatchObject({
      toolResult: {
        articleId: 4242,
        blogId: 200,
        blogHandle: 'editorial',
        handle: 'xia-ri-chuan-da-5-ge-bi-bei-dan-pin',
        articleUrl: 'https://demo-shop.myshopify.com/admin/articles/4242',
        status: 'draft',
      },
      toolExecutedAt: expect.any(String),
    });
  });

  it('publishToShopify=false → no pendingToolCall, plain done on approve', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    // Bind creds (still required by manifest), then opt out of publishing.
    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_x',
      metadata: { storeUrl: 'demo-shop.myshopify.com' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-blog-writer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { targetLanguages: ['en'], publishToShopify: false } },
    });

    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptStructured({
      title: 'Drafts only mode',
      bodyHtml: '<p>This article should never reach Shopify.</p>',
      summaryHtml: 'A draft to be exported manually.',
      tags: ['draft', 'manual'],
      language: 'en',
      progressNote: 'Draft done, saving locally per the publishToShopify=false config.',
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'draft only please' },
    });
    const taskId = create.json().id as string;
    await drainNextTask();

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.output).not.toHaveProperty('pendingToolCall');
    expect(task.output).toMatchObject({
      article: { title: 'Drafts only mode' },
      publishToShopify: false,
    });

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('done');
    // No Shopify call ever happened.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blogHandle that does not exist on the store → task fails with clear error', async () => {
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
      url: '/v1/agents/shopify-blog-writer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: {
          targetLanguages: ['en'],
          publishToShopify: true,
          blogHandle: 'doesnt-exist',
        },
      },
    });

    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptStructured({
      title: 'Will fail to publish',
      bodyHtml: '<p>Long enough body to satisfy the schema minimum length.</p>',
      summaryHtml: 'A summary that will never be published.',
      tags: ['fail'],
      language: 'en',
      progressNote: 'Draft ready, queued for publish.',
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'try to publish' },
    });
    const taskId = create.json().id as string;
    await drainNextTask();

    // Shopify returns a list of blogs that does NOT include the configured handle.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ blogs: [{ id: 100, handle: 'news', title: 'News' }] }),
    } as unknown as Response);

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBeGreaterThanOrEqual(500);

    const task = await getTask(tenantId, taskId);
    expect(task.status).toBe('failed');
    expect(task.error?.message).toMatch(/doesnt-exist/);
  });
});
