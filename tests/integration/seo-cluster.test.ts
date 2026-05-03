/**
 * End-to-end integration test: Strategist → Writer EEAT → Writer draft → approve flow.
 *
 * After the markdown-first refactor, the strategist passes a markdown brief
 * to the child via `input.brief` + `input.refs.{primaryKeyword,language}`.
 * The writer's Stage 1 (EEAT Q&A) fires whenever `params.refs.primaryKeyword`
 * is present (i.e. the task came from the strategist), so the full e2e path
 * goes through both stages.
 *
 * Flow:
 *   1. POST /v1/tasks (strategy brief) → drain → Strategist runs two-pass
 *   2. approve(finalize=true) → 1 writer child spawned with markdown brief + refs
 *   3. drain Writer → Stage 1 fires (EEAT questions) → task waiting with eeatPending
 *   4. boss feedback → task back to todo
 *   5. drain Writer → Stage 2 fires → task waiting with pendingToolCall
 *   6. approve(finalize=true) → shopify.publish_article fires → done
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

    // ── Phase 3: Writer Stage 1 — EEAT questions (refs.primaryKeyword triggers it) ─
    scriptStructured({
      questions: [
        { question: 'How many wash cycles before pilling shows?', optional: false },
        { question: 'Have you worn it in 35°C humid weather? How did it feel?', optional: true },
      ],
      narrative:
        '## Why I need your input\n\nFirst-hand wash + wear data is the EEAT moat for this article. I will fold the numbers into the opening paragraph.',
      progressNote: 'Got a few EEAT questions before drafting',
    });

    const stage1Drain = await drainNextTask();
    expect(stage1Drain.taskId).toBe(childId);

    let child = await getTask(tenantId, childId);
    expect(child.status).toBe('waiting');
    expect(child.output).toMatchObject({
      eeatPending: { questions: expect.any(Array), askedAt: expect.any(String) },
      artifact: {
        report: expect.stringContaining('我需要先請你回答幾個問題'),
        refs: { askedAt: expect.any(String) },
      },
    });
    expect(child.output).not.toHaveProperty('pendingToolCall');

    // ── Phase 4: boss replies with EEAT answers → task → todo ───────────────
    const feedback = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${childId}/feedback`,
      headers: authHeaders(jwt, tenantId),
      payload: { feedback: 'Washed it 12 times — no pilling. 35°C humid is fine, dries fast.' },
    });
    expect(feedback.statusCode).toBe(200);

    // ── Phase 5: Writer Stage 2 — draft article ─────────────────────────────
    scriptStructured({
      title: 'Linen Shirts: The Ultimate Summer Guide',
      body: '## Why Linen?\n\nLightweight, breathable, and a perfect match for humid summers. Washed it 12 times without pilling.',
      summaryHtml: 'A first-hand guide to linen shirts for humid summer climates.',
      tags: ['linen', 'summer', 'fabric guide'],
      language: 'en',
      report:
        '## Decision\n\nOpening paragraph leads with the boss-provided 12-wash data point — strongest EEAT signal we have. Comparison table left out to keep length under 1200 words.',
      progressNote: '草稿好了，老闆過目',
    });

    const writerDrain = await drainNextTask();
    expect(writerDrain.taskId).toBe(childId);

    child = await getTask(tenantId, childId);
    expect(child.status).toBe('waiting');
    expect(child.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('Decision'),
        body: expect.stringContaining('## Why Linen?'),
        refs: expect.objectContaining({
          title: expect.stringContaining('Linen'),
          language: 'en',
        }),
      },
      pendingToolCall: { id: 'shopify.publish_article' },
    });

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
        report: expect.stringContaining('Decision'),
        body: expect.stringContaining('## Why Linen?'),
        refs: expect.objectContaining({
          title: expect.stringContaining('Linen'),
          published: expect.objectContaining({
            articleId: 9001,
            blogId: 200,
            blogHandle: 'news',
            handle: 'linen-summer-guide',
          }),
        }),
      },
      toolExecutedAt: expect.any(String),
    });
    expect(child.output).not.toHaveProperty('pendingToolCall');
  });
});
