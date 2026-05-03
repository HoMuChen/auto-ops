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
      overview:
        '## 觀察\n\n夏季 SEO 主要兩條主軸：本地穿搭實戰、永續材質採購。台灣濕熱氣候是市場切角。\n\n## 策略\n\n選兩篇打不重疊：zh-TW 在地穿搭 + en 永續 buyer guide。',
      progressNote: '規劃了 2 個切角，主軸是夏季關鍵字，老闆過目',
      topics: [
        {
          title: '夏季穿搭 5 個必備單品',
          primaryKeyword: '夏季穿搭',
          language: 'zh-TW',
          writerBrief:
            '**搜尋意圖**: commercial\n\n### PAA\n- Is linen good for summer?\n\n### 競品缺口\n沒有台灣濕熱氣候的穿搭建議。\n\n### 目標\n1500 字 long-form article on layered summer styling for humid Taiwan climate.',
          assignedAgent: 'shopify-blog-writer',
        },
        {
          title: 'Sustainable summer fabrics buyer guide',
          primaryKeyword: 'sustainable fabrics summer',
          language: 'en',
          writerBrief:
            '**Search intent**: informational\n\n### PAA\n- What is the most sustainable fabric?\n\n### Competitor gap\nNo first-hand washing data.\n\n### Target\nBuyer guide comparing linen, organic cotton and Tencel for summer apparel.',
          assignedAgent: 'shopify-blog-writer',
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
    // The plan (markdown report) and the pending children specs should both be in output.
    expect(parent.output).toMatchObject({
      artifact: {
        report: expect.any(String),
      },
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
      expect((child.input as { brief: string }).brief).toEqual(expect.any(String));
      expect(child.input).toHaveProperty('refs');
      const refs = (child.input as { refs: Record<string, unknown> }).refs;
      expect(refs).toHaveProperty('primaryKeyword');
      expect(refs).toHaveProperty('language');
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
    // Each child has assignedAgent='shopify-blog-writer' so the supervisor short-circuits.
    // Children carry refs.primaryKeyword (strategist signal) so Stage 1 (EEAT) fires
    // first; we then post boss feedback to drive Stage 2 (article draft).
    expect(pendingScript()).toBe(0);

    // Script Stage 1 (EEAT questions) for each child.
    for (let i = 0; i < children.length; i++) {
      scriptStructured({
        questions: [
          {
            question: `For child ${i + 1}: how long have you actually used this product?`,
            optional: false,
          },
        ],
        narrative:
          '## Why I need your input\n\nFirst-hand wear/use data is the EEAT moat for this article — I will fold it into the opener.',
        progressNote: `Stage 1 EEAT for child ${i + 1}`,
      });
    }

    const c1 = await drainNextTask();
    expect(c1.claimed).toBe(true);
    const c2 = await drainNextTask();
    expect(c2.claimed).toBe(true);

    // Stage 1 outcome: each child waiting with eeatPending + report artifact
    for (const child of children) {
      const refreshed = await getTask(tenantId, child.id);
      expect(refreshed.status).toBe('waiting');
      expect(refreshed.output).toMatchObject({
        eeatPending: { questions: expect.any(Array), askedAt: expect.any(String) },
        artifact: {
          report: expect.stringContaining('我需要先請你回答幾個問題'),
          refs: { askedAt: expect.any(String) },
        },
      });
      expect(refreshed.output).not.toHaveProperty('pendingToolCall');
    }

    // Boss replies with EEAT answers → each child back to todo
    for (const child of children) {
      const fb = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${child.id}/feedback`,
        headers: authHeaders(jwt, tenantId),
        payload: { feedback: 'Worn it for 3 summers, washed weekly, no issues.' },
      });
      expect(fb.statusCode).toBe(200);
    }

    // Script Stage 2 (article draft) for each child.
    for (let i = 0; i < children.length; i++) {
      scriptStructured({
        title: `Article ${i + 1} draft`,
        body: `## Section ${i + 1}\n\nBody ${i + 1} long enough to satisfy the schema minimum after the markdown migration.`,
        summaryHtml: `Summary ${i + 1} for the article excerpt and meta description.`,
        tags: ['seo', 'summer'],
        language: i === 0 ? 'zh-TW' : 'en',
        report: `## Decision\n\nArticle ${i + 1} leads with the boss's first-hand wear data. Length kept tight.`,
        progressNote: `Article ${i + 1} 草稿好了，老闆過目`,
      });
    }

    const c1b = await drainNextTask();
    expect(c1b.claimed).toBe(true);
    const c2b = await drainNextTask();
    expect(c2b.claimed).toBe(true);

    for (const child of children) {
      const refreshed = await getTask(tenantId, child.id);
      expect(refreshed.status).toBe('waiting');
      expect(refreshed.output).toMatchObject({
        artifact: {
          report: expect.stringContaining('Decision'),
          body: expect.stringContaining('## Section'),
          refs: expect.objectContaining({ title: expect.stringContaining('Article') }),
        },
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
      // tool-executor leaves new flat artifacts unchanged — publish metadata
      // lives only in the task log line.
      expect(final.output).toMatchObject({
        artifact: {
          report: expect.stringContaining('Decision'),
          body: expect.stringContaining('## Section'),
          refs: expect.objectContaining({ title: expect.stringContaining('Article') }),
        },
        toolExecutedAt: expect.any(String),
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(children.length * 2);
  });
});
