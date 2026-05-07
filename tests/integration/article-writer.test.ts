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

describe('article-writer atomic agent — direct routing', () => {
  it('drafts → report-writer renders prose → waiting → approve → publish', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_test_token',
      metadata: { storeUrl: 'demo-shop.myshopify.com' },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/agents/article-writer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: { publishToShopify: true, blogHandle: 'editorial' },
      },
    });

    scriptStructured({ nextAgent: 'article-writer', clarification: null, done: false });
    scriptToolCall('submit_article', {
      title: 'Summer linen guide',
      slug: 'summer-linen-guide',
      body: '## Why linen wins in summer\n\nLong enough body content to satisfy schema minimum.',
      summaryHtml: 'Linen guide summary that meets the schema minimum length.',
      tags: ['linen', 'summer'],
      language: 'en',
      author: 'Editorial Team',
      keyDecisions: ['Hook with material-science angle', 'Lead with data'],
      progressNote: 'Draft done.',
    });
    // Report-writer renders boss prose for schemaName='article-draft'.
    scriptText(
      '## 切角\n\n從機能性切入，避開純穿搭的泛論。\n\n## EEAT 強化點\n\n用實穿經驗開頭，立刻拉開差距。',
    );

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'write a linen guide' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('article-writer');
    expect(task.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer, contains the prose it
        // generated — NOT a verbatim copy of structuredOutput.data.
        report: expect.stringContaining('切角'),
        body: expect.stringContaining('Why linen wins'),
        refs: expect.objectContaining({ title: 'Summer linen guide' }),
      },
      lastStructuredOutput: {
        schemaName: 'article-draft',
        data: expect.objectContaining({ title: 'Summer linen guide' }),
        keyDecisions: expect.arrayContaining(['Hook with material-science angle']),
      },
      pendingToolCall: {
        id: 'shopify.publish_article',
        args: expect.objectContaining({
          bodyHtml: expect.stringContaining('<h2>Why linen wins in summer</h2>'),
        }),
      },
    });

    // Stub Shopify: blogs.json (find 'editorial') + article create.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ blogs: [{ id: 200, handle: 'editorial', title: 'Editorial' }] }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => '',
        json: async () => ({
          article: { id: 4242, handle: 'summer-linen-guide', blog_id: 200, published_at: null },
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
    expect(task.output).not.toHaveProperty('pendingToolCall');
  });
});
