/**
 * End-to-end integration test: Strategist → Writer draft → approve flow.
 *
 * After the markdown-first refactor (Task 4), the strategist passes a markdown
 * brief to the child via `input.brief` + `input.refs.{primaryKeyword,language}`.
 * It no longer emits a structured `research` block — so the writer's Stage 1
 * (EEAT Q&A) does not fire from this strategist-spawned path. EEAT coverage
 * lives in `shopify-blog-writer-eeat.test.ts`, which exercises the writer in
 * isolation with `params.research.eeatHook` injected directly.
 *
 * Flow:
 *   1. POST /v1/tasks (strategy brief) → drain → Strategist runs two-pass (bindTools + plan)
 *   2. approve(finalize=true) → 1 writer child spawned with markdown brief + refs
 *   3. drain Writer → Stage 2 fires (no EEAT path) → task waiting with pendingToolCall
 *   4. approve(finalize=true) → shopify.publish_article fires → done
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

describe('SEO cluster: Strategist → Writer draft → approve', () => {
  it('full pipeline: plan → spawn → article → publish', async () => {
    // ── Setup ────────────────────────────────────────────────────────────────
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'pro' });
    const jwt = await mintJwt({ userId, email });

    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_cluster_test',
      metadata: { storeUrl: 'cluster-shop.myshopify.com' },
    });

    // Stub fetch: google.serper.dev returns canned SERP; myshopify.com returns
    // blog list + article create on the publish step.
    fetchMock.mockImplementation(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('serper.dev')) {
        return new Response(
          JSON.stringify({
            organic: [
              {
                title: 'Linen shirts for summer',
                link: 'https://a.example.com',
                snippet: 'Guide',
                position: 1,
              },
            ],
            peopleAlsoAsk: [{ question: 'Is linen good for summer?' }],
            relatedSearches: [{ query: 'linen vs cotton summer' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (urlStr.includes('myshopify.com') && urlStr.includes('blogs.json')) {
        return new Response(
          JSON.stringify({ blogs: [{ id: 200, handle: 'news', title: 'News' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (urlStr.includes('myshopify.com') && urlStr.includes('articles.json')) {
        return new Response(
          JSON.stringify({
            article: { id: 9001, handle: 'linen-summer-guide', blog_id: 200, published_at: null },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    // ── Phase 1: Strategist runs (supervisor + two-pass tool+plan) ────────────
    // Supervisor routes to seo-strategist (structured).
    scriptStructured({ nextAgent: 'seo-strategist', clarification: null, done: false });
    // Strategist pass 2: structured plan (pass 1 = bindTools with no tool calls).
    scriptStructured({
      overview:
        '## 觀察\n\n聚焦亞麻襯衫單一主題，驗證 EEAT 流程。研究 SERP 後發現 PAA 主集中在保養與穿著體驗。\n\n## 策略\n\n切角放在台灣濕熱氣候下的真實穿著體驗，這是市場缺口。',
      progressNote: '規劃了 1 個主題，用來測試 EEAT 流程，老闆過目',
      topics: [
        {
          title: 'Linen shirts summer guide',
          primaryKeyword: 'linen shirt summer',
          language: 'en',
          writerBrief:
            '**Search intent**: commercial\n\n### PAA\n- Is linen good for summer?\n- How to care for linen?\n\n### Related queries\n- linen vs cotton summer\n- best linen shirts 2026\n\n### Competitor gap\nNo Taiwan humidity specifics.\n\n### Target\n~1200 words. Comprehensive guide on linen shirts for humid summer climates.\n\n### E-E-A-T hook\nBoss should share washing experience and wearability in humid heat.',
          assignedAgent: 'shopify-blog-writer',
        },
      ],
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'Plan a linen shirt SEO article for summer' },
    });
    expect(create.statusCode).toBe(201);
    const parentId = create.json().id as string;

    const drained = await drainNextTask();
    expect(drained.taskId).toBe(parentId);

    const parent = await getTask(tenantId, parentId);
    expect(parent.status).toBe('waiting');
    expect(parent.kind).toBe('strategy');
    expect(parent.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('Linen shirts summer guide'),
      },
    });

    // ── Phase 2: finalize → spawn 1 writer child ──────────────────────────────
    const finalize = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${parentId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(finalize.statusCode).toBe(200);

    const children = await listTasks(tenantId, { parentTaskId: parentId });
    expect(children).toHaveLength(1);
    const firstChild = children[0];
    if (!firstChild) throw new Error('Expected at least one child task');
    const childId = firstChild.id;

    // Child carries the markdown brief + minimal refs (post-Task-4 contract)
    expect(firstChild.input).toMatchObject({
      brief: expect.stringContaining('Search intent'),
      refs: {
        primaryKeyword: 'linen shirt summer',
        language: 'en',
      },
    });
    expect((firstChild.input as { brief: string }).brief).toContain('PAA');

    // ── Phase 3: Writer Stage 2 — draft article (no EEAT path from strategist) ─
    scriptStructured({
      title: 'Linen Shirts: The Ultimate Summer Guide',
      bodyHtml:
        '<h2>Why Linen?</h2><p>Lightweight, breathable, and a perfect match for humid summers.</p>',
      summaryHtml: 'A first-hand guide to linen shirts for humid summer climates.',
      tags: ['linen', 'summer', 'fabric guide'],
      language: 'en',
      progressNote: '草稿好了，老闆過目',
    });

    const writerDrain = await drainNextTask();
    expect(writerDrain.taskId).toBe(childId);

    let child = await getTask(tenantId, childId);
    expect(child.status).toBe('waiting');
    expect(child.output).toMatchObject({
      artifact: {
        kind: 'blog-article',
        data: { title: expect.stringContaining('Linen') },
      },
      pendingToolCall: { id: 'shopify.publish_article' },
    });
    expect(child.output).not.toHaveProperty('eeatPending');

    // ── Phase 4: approve → publish_article fires ──────────────────────────────
    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${childId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    child = await getTask(tenantId, childId);
    expect(child.status).toBe('done');
    expect(child.output).toMatchObject({
      artifact: {
        kind: 'blog-article',
        published: { articleId: 9001, blogId: 200, status: 'draft' },
      },
      toolExecutedAt: expect.any(String),
    });
  });
});
