import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import { clearScript, llmMockModule, pendingScript, scriptStructured } from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

// Stub fetch so shopify-blog-writer's publish_article call doesn't actually hit Shopify.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { createTestApp } = await import('./helpers/app.js');
const { getTask, listTasks } = await import('../../src/tasks/repository.js');
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

describe('Strategy → Spawn → Execution flow', () => {
  it('strategist plans, finalize spawns children, each child runs through HITL', async () => {
    // Strategist is gated to pro+ — seed accordingly.
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'pro' });
    const jwt = await mintJwt({ userId, email });
    // Children are shopify-blog-writer tasks that publish to Shopify; bind a credential
    // so the publish tool can resolve creds when it fires on approve.
    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_test_secret',
      metadata: { storeUrl: 'demo-shop.myshopify.com' },
    });

    // ── Phase 1: parent strategy task ──────────────────────────────────────
    // Supervisor picks the strategist (one structured call), then the
    // strategist itself returns a structured content plan (second structured
    // call). No text completion is needed because the agent uses
    // withStructuredOutput end-to-end.
    scriptStructured({
      nextAgent: 'seo-strategist',
      clarification: null,
      done: false,
    });
    scriptStructured({
      reasoning: 'Three-pronged plan covering core summer keyword clusters.',
      progressNote: '規劃了 2 個切角，主軸是夏季關鍵字，老闆過目',
      topics: [
        {
          title: '夏季穿搭 5 個必備單品',
          primaryKeyword: '夏季穿搭',
          language: 'zh-TW',
          writerBrief:
            '1500 字 long-form article on layered summer styling for humid Taiwan climate.',
          assignedAgent: 'shopify-blog-writer',
          searchIntent: 'commercial',
          paaQuestions: ['Is linen good for summer?'],
          relatedSearches: ['linen vs cotton'],
          competitorTopAngles: ['fabric guides'],
          competitorGaps: ['no Taiwan-specific humidity advice'],
          targetWordCount: 1200,
          eeatHook: '',
        },
        {
          title: 'Sustainable summer fabrics buyer guide',
          primaryKeyword: 'sustainable fabrics summer',
          language: 'en',
          writerBrief: 'Buyer guide comparing linen, organic cotton and Tencel for summer apparel.',
          assignedAgent: 'shopify-blog-writer',
          searchIntent: 'informational',
          paaQuestions: ['What is the most sustainable fabric?'],
          relatedSearches: ['eco-friendly fabrics'],
          competitorTopAngles: ['comparison tables'],
          competitorGaps: ['no first-hand washing data'],
          targetWordCount: 1500,
          eeatHook: '',
        },
      ],
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'Plan the summer SEO campaign for our store' },
    });
    expect(create.statusCode).toBe(201);
    const parentId = create.json().id as string;

    // Drive the worker to run the strategy task.
    const drained = await drainNextTask();
    expect(drained.taskId).toBe(parentId);

    let parent = await getTask(tenantId, parentId);
    expect(parent.status).toBe('waiting');
    // Runner should auto-promote kind because the agent emitted spawnTasks.
    expect(parent.kind).toBe('strategy');
    // The plan and the pending children specs should both be in output.
    expect(parent.output).toMatchObject({
      plan: { topics: expect.any(Array) },
      spawnTasks: expect.arrayContaining([
        expect.objectContaining({ assignedAgent: 'shopify-blog-writer' }),
      ]),
    });

    // No children spawned yet — they appear only on finalize-approve.
    const beforeApprove = await listTasks(tenantId, { parentTaskId: parentId });
    expect(beforeApprove).toHaveLength(0);

    // ── Phase 2: approve(finalize=true) → spawn ────────────────────────────
    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${parentId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    parent = await getTask(tenantId, parentId);
    expect(parent.status).toBe('done');
    // Idempotency markers stamped.
    expect(parent.output).toMatchObject({
      spawnedAt: expect.any(String),
      spawnedTaskIds: expect.arrayContaining([expect.any(String)]),
    });

    const children = await listTasks(tenantId, { parentTaskId: parentId });
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.kind).toBe('execution');
      expect(child.assignedAgent).toBe('shopify-blog-writer');
      expect(child.status).toBe('todo');
      expect(child.input).toHaveProperty('brief');
      expect(child.input).toHaveProperty('research');
      expect((child.input as { research?: { targetWordCount?: number } }).research?.targetWordCount).toBeGreaterThan(0);
    }

    // ── Phase 3: idempotent re-approve (network retry) ─────────────────────
    // Calling approve again on a done strategy task currently throws because
    // the state machine refuses done → done. The repository's idempotency
    // safeguard is for `finalizeStrategyTask` itself, not the approve route.
    // Confirm no duplicate children if we manually call the helper twice.
    const { finalizeStrategyTask } = await import('../../src/tasks/repository.js');
    const replay = await finalizeStrategyTask(tenantId, parentId);
    expect(replay.children).toHaveLength(2);
    const stillTwo = await listTasks(tenantId, { parentTaskId: parentId });
    expect(stillTwo).toHaveLength(2);

    // ── Phase 4: drain children — supervisor LLM is BYPASSED via pinning ───
    // Each child has assignedAgent='shopify-blog-writer' so the supervisor short-circuits;
    // only the writer's structured output needs to be scripted (one per child).
    expect(pendingScript()).toBe(0);
    for (let i = 0; i < children.length; i++) {
      scriptStructured({
        title: `Article ${i + 1} draft`,
        bodyHtml: `<p>Body ${i + 1} long enough to satisfy the schema minimum.</p>`,
        summaryHtml: `Summary ${i + 1} for the article excerpt and meta description.`,
        tags: ['seo', 'summer'],
        language: i === 0 ? 'zh-TW' : 'en',
        progressNote: `Article ${i + 1} 草稿好了，老闆過目`,
      });
    }

    const c1 = await drainNextTask();
    expect(c1.claimed).toBe(true);
    const c2 = await drainNextTask();
    expect(c2.claimed).toBe(true);

    for (const child of children) {
      const refreshed = await getTask(tenantId, child.id);
      expect(refreshed.status).toBe('waiting');
      expect(refreshed.output).toMatchObject({
        article: { title: expect.stringContaining('Article') },
        pendingToolCall: { id: 'shopify.publish_article' },
      });
    }

    // ── Phase 5: approve each child as final → publish_article fires twice ─
    // Each approve = one listBlogs + one createArticle = 2 fetch calls.
    for (let i = 0; i < children.length; i++) {
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
              id: 1000 + i,
              handle: `article-${i + 1}`,
              blog_id: 100,
              published_at: null,
            },
          }),
        } as unknown as Response);
    }

    for (const child of children) {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${child.id}/approve`,
        headers: authHeaders(jwt, tenantId),
        payload: { finalize: true },
      });
      expect(r.statusCode).toBe(200);
      const final = await getTask(tenantId, child.id);
      expect(final.status).toBe('done');
      expect(final.output).toMatchObject({
        toolResult: { blogId: 100, status: 'draft' },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(children.length * 2);
  });
});
