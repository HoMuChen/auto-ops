/**
 * End-to-end integration test: full Strategist → Writer EEAT Q&A → draft → approve flow.
 *
 * Flow:
 *   1. POST /v1/tasks (strategy brief) → drain → Strategist runs two-pass (bindTools + plan)
 *   2. approve(finalize=true) → 1 writer child spawned
 *   3. drain Writer → Stage 1 fires (research.eeatHook present) → task waiting with eeatPending
 *   4. POST /feedback with boss answers → task todo
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

describe('SEO cluster: Strategist → Writer EEAT Q&A → draft → approve', () => {
  it('full pipeline: research → questions → answers → article → publish', async () => {
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
      reasoning: 'One focused linen article to validate the EEAT pipeline.',
      progressNote: '規劃了 1 個主題，用來測試 EEAT 流程，老闆過目',
      topics: [
        {
          title: 'Linen shirts summer guide',
          primaryKeyword: 'linen shirt summer',
          language: 'en',
          writerBrief: 'Comprehensive guide on linen shirts for humid summer climates.',
          assignedAgent: 'shopify-blog-writer',
          searchIntent: 'commercial',
          paaQuestions: ['Is linen good for summer?', 'How to care for linen?'],
          relatedSearches: ['linen vs cotton summer', 'best linen shirts 2026'],
          competitorTopAngles: ['fabric comparison', 'care guides'],
          competitorGaps: ['no Taiwan humidity specifics'],
          targetWordCount: 1200,
          eeatHook: 'Boss should share washing experience and wearability in humid heat.',
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
        kind: 'seo-plan',
        data: {
          topics: expect.arrayContaining([
            expect.objectContaining({ primaryKeyword: 'linen shirt summer' }),
          ]),
        },
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

    // Child carries full research block including eeatHook
    expect(firstChild.input).toMatchObject({
      research: {
        searchIntent: 'commercial',
        eeatHook: expect.stringContaining('washing'),
        targetWordCount: 1200,
      },
    });

    // ── Phase 3: Writer Stage 1 — EEAT questions ──────────────────────────────
    scriptStructured({
      questions: [
        {
          question: 'How many times have you washed the linen shirt before pilling started?',
          hint: 'Specific numbers build trust.',
          optional: false,
        },
        {
          question: "How did it feel in Taiwan's 35°C humid summer?",
          optional: true,
        },
      ],
      progressNote: '有兩個 EEAT 問題想請老闆先回答，這樣文章說服力更強',
    });

    const writerDrain1 = await drainNextTask();
    expect(writerDrain1.taskId).toBe(childId);

    let child = await getTask(tenantId, childId);
    expect(child.status).toBe('waiting');
    expect(child.output).toMatchObject({
      eeatPending: {
        questions: expect.arrayContaining([
          expect.objectContaining({ question: expect.any(String) }),
        ]),
        askedAt: expect.any(String),
      },
    });
    expect(child.output).not.toHaveProperty('pendingToolCall');

    // ── Phase 4: Boss answers EEAT questions ──────────────────────────────────
    const feedback = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${childId}/feedback`,
      headers: authHeaders(jwt, tenantId),
      payload: { feedback: '洗了 10 次完全沒起球。台北 35 度穿，涼到不像麻，比想像中舒服。' },
    });
    expect(feedback.statusCode).toBe(200);

    child = await getTask(tenantId, childId);
    expect(child.status).toBe('todo');

    // ── Phase 5: Writer Stage 2 — draft article ───────────────────────────────
    scriptStructured({
      title: 'Linen Shirts: The Ultimate Summer Guide (Tested in Taiwan Heat)',
      bodyHtml:
        '<h2>Why Linen?</h2><p>After 10 washes with zero pilling, and wearing it in 35°C Taipei humidity — yes, linen delivers.</p>',
      summaryHtml: 'A first-hand guide to linen shirts for humid summer climates.',
      tags: ['linen', 'summer', 'fabric guide'],
      language: 'en',
      progressNote: '草稿好了，開頭放了老闆親身體驗的數字，相信讀者會買單',
    });

    const writerDrain2 = await drainNextTask();
    expect(writerDrain2.taskId).toBe(childId);

    child = await getTask(tenantId, childId);
    expect(child.status).toBe('waiting');
    expect(child.output).toMatchObject({
      artifact: {
        kind: 'blog-article',
        data: { title: expect.stringContaining('Linen') },
      },
      pendingToolCall: { id: 'shopify.publish_article' },
    });
    expect(child.output).not.toHaveProperty('eeatPending');

    // ── Phase 6: approve → publish_article fires ──────────────────────────────
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

    // Verify message thread: brief → EEAT questions (assistant) → boss answers → draft → done
    const messages = (await app
      .inject({
        method: 'GET',
        url: `/v1/tasks/${childId}/messages`,
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json())) as { role: string; content: string }[];

    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(expect.arrayContaining(['user', 'assistant', 'user', 'assistant']));
    expect(messages.some((m) => m.content.includes('EEAT'))).toBe(true);
    expect(messages.some((m) => m.content.includes('10 次'))).toBe(true);
    // Article title check moved to the artifact assertion above (line ~233);
    // messages now hold only short progressNotes, not the article preview.
  });
});
