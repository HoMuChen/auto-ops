import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import { clearScript, llmMockModule, scriptStructured } from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

// Replace the real model registry BEFORE any module under test imports it.
vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

// Stub fetch so the shopify-blog-writer's publish_article tool doesn't actually call
// Shopify. Shared across the file; reset between tests.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Imports that depend on the mocked module:
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

/**
 * Article fixture for shopify-blog-writer's withStructuredOutput call. Centralised so
 * each test can just `scriptStructured(article())`.
 */
function article(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    title: 'Summer Dresses Buying Guide',
    bodyHtml: '<p>The lightweight cuts that work all summer long.</p>',
    summaryHtml: 'A short guide to summer dresses for hot, humid weather.',
    tags: ['summer', 'dresses', 'guide'],
    language: 'zh-TW',
    progressNote: '草稿好了，這篇我著重在輕薄涼感面料，老闆看一下開頭那段',
    ...overrides,
  };
}

/** Insert a Shopify credential row directly so tests don't need to call the API. */
async function bindShopifyCredential(tenantId: string): Promise<void> {
  await db.insert(tenantCredentials).values({
    tenantId,
    provider: 'shopify',
    secret: 'shpat_test_secret',
    metadata: { storeUrl: 'demo-shop.myshopify.com' },
  });
}

describe('Task lifecycle — happy path through HITL gate', () => {
  it('POST /tasks → worker runs → waiting → /approve(finalize) → publishes → done', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });
    await bindShopifyCredential(tenantId);

    // Script the supervisor + agent for one full graph turn:
    //   1. Supervisor routes to shopify-blog-writer.
    //   2. shopify-blog-writer returns a structured article via withStructuredOutput.
    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptStructured(article());

    // 1. Dispatch the brief.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'Write an SEO article about summer dresses' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('todo');

    // 2. Drive one worker tick → graph runs → HITL gate.
    const drained = await drainNextTask();
    expect(drained.taskId).toBe(taskId);

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.output).toMatchObject({
      artifact: {
        kind: 'blog-article',
        data: { title: 'Summer Dresses Buying Guide' },
      },
      pendingToolCall: { id: 'shopify.publish_article' },
    });
    expect(task.lockedBy).toBeNull();

    const messages = await app
      .inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/messages`,
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);

    const logs = await app
      .inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/logs`,
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    const events = logs.map((l: { event: string }) => l.event);
    // The agent's own "draft ready" log is now the user-visible "awaiting"
    // signal — task.waiting was framework noise duplicating it, and was cut.
    expect(events).toContain('agent.draft.ready');
    // And every agent-emitted log carries the speaker tag.
    const draftLog = logs.find((l: { event: string }) => l.event === 'agent.draft.ready');
    expect(draftLog?.speaker).toBe('shopify-blog-writer');

    // 3. Approve as final → triggers publish_article. Stub blogs.json + articles.json.
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
          article: {
            id: 555,
            handle: 'summer-dresses-buying-guide',
            blog_id: 100,
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

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('done');
    expect(task.output).toMatchObject({
      artifact: {
        kind: 'blog-article',
        published: {
          articleId: 555,
          blogId: 100,
          handle: 'summer-dresses-buying-guide',
          status: 'draft',
        },
      },
    });
    expect(task.completedAt).not.toBeNull();
  });

  it('non-finalize approve re-queues the task to todo (waiting → todo transition)', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });
    await bindShopifyCredential(tenantId);

    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptStructured(article({ title: 'First draft' }));

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'something' },
    });
    const taskId = create.json().id as string;
    await drainNextTask();

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: false },
    });
    expect(approve.statusCode).toBe(200);

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('todo');
    expect(task.completedAt).toBeNull();
    // No tool fired — non-finalize doesn't trigger publishing.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('feedback re-queues with the new user message visible to the agent', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });
    await bindShopifyCredential(tenantId);

    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptStructured(article({ title: 'First draft' }));

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'first brief' },
    });
    const taskId = create.json().id as string;
    await drainNextTask();

    const feedback = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/feedback`,
      headers: authHeaders(jwt, tenantId),
      payload: { feedback: 'Make the tone more playful' },
    });
    expect(feedback.statusCode).toBe(200);

    const task = await getTask(tenantId, taskId);
    expect(task.status).toBe('todo');

    const messages = await app
      .inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/messages`,
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    // user (brief), assistant (the rendered preview from the agent), user (feedback)
    const contents = messages.map((m: { role: string; content: string }) => m.content);
    expect(contents[0]).toBe('first brief');
    expect(contents[1]).toContain('草稿好了'); // assistant progressNote
    expect(contents[2]).toBe('Make the tone more playful');
  });
});
