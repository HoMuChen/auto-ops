/**
 * End-to-end integration test: product-planner → product-designer → shopify-publisher
 *
 * Flow:
 *   1. POST /v1/tasks → drain → product-planner runs (bindTools no-op + PlanSchema) → waiting/strategy
 *   2. approve(finalize=true) → spawns 1 product-designer child
 *   3. drain designer → runs (bindTools no-op + ProductListingSchema) → waiting/strategy with spawnTasks
 *   4. approve(finalize=true) → spawns 1 shopify-publisher child
 *   5. drain publisher → waiting with pendingToolCall = shopify.create_product
 *   6. approve(finalize=true) → fires create_product → done
 */
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
const { getTask, listTasks } = await import('../../src/tasks/repository.js');

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

describe('product-planner → product-designer → shopify-publisher end-to-end', () => {
  it('plan → approve → design → approve → publish → done', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    // Bind Shopify credential for the publisher
    await app.inject({
      method: 'PUT',
      url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: { secret: 'shpat_test', metadata: { storeUrl: 'demo.myshopify.com' } },
    });

    // Activate all three agents
    await app.inject({
      method: 'POST',
      url: '/v1/agents/product-planner/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { defaultLanguages: ['zh-TW'] } },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/agents/product-designer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { defaultLanguage: 'zh-TW', defaultVendor: 'Acme' } },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-publisher/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: {} },
    });

    // ── Phase 1: product-planner runs ────────────────────────────────────────
    // Supervisor routes to product-planner (structured).
    scriptStructured({ nextAgent: 'product-planner', clarification: null, done: false });
    // Planner is single-pass now: tool-loop with finalAnswer:PlanSchema, model
    // submits via the submit_plan tool. No second structured-output round-trip.
    scriptToolCall('submit_plan', {
      reasoning: 'One Shopify variant for zh-TW e-commerce.',
      overview: `## 市場觀察

台灣夏季 SERP 對亞麻多半關注「悶熱」「縮水」恐懼，反向操作 → 主打 180g 不悶 + 可機洗。

## 我的策略

聚焦 1 個 variant：zh-TW 電商頁面，切「機能透氣」+ 在地實穿。`,
      progressNote: '規劃好了，1 個 variant，老闆看一下',
      keyDecisions: [
        '反向操作 SERP 悶熱恐懼，主打 180g 不悶',
        '聚焦 1 個 zh-TW 電商 variant 切機能透氣',
      ],
      variants: [
        {
          title: '亞麻短袖 - 電商版 (zh-TW)',
          platform: 'shopify',
          language: 'zh-TW',
          brief: `### Marketing angle
台灣濕熱夏天通勤族，怕熱怕悶；切「機能透氣」+ 在地實穿。

### Key messages
- 180g 亞麻不悶熱
- 可機洗

### Copy brief
**Tone**: warm, professional
**Features to highlight**: fabric weight, washability
**Forbidden claims**: 無

### Image plan
- **Hero (required)**：clean white background`,
          assignedAgent: 'product-designer',
        },
      ],
    });
    // Report-writer LLM call for schemaName='product-plan'. NOTE: NO extra
    // scriptStructured here — supervisor short-circuits without an LLM call
    // when awaitingApproval=true (src/orchestrator/supervisor.ts:69-72), so
    // adding one would leak into the queue and be consumed by report-writer's
    // plain `.invoke()`.
    scriptText(
      '## 我的策略\n\n反向操作 SERP 悶熱恐懼。\n\n## 為什麼這樣選\n\n台灣夏天通勤族對亞麻有刻板印象，正面挑戰反而能站穩位置。',
    );

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'List this linen shirt for Taiwan market' },
    });
    expect(create.statusCode).toBe(201);
    const plannerTaskId = create.json().id as string;

    await drainNextTask();
    const plannerTask = await getTask(tenantId, plannerTaskId);
    expect(plannerTask.status).toBe('waiting');
    expect(plannerTask.kind).toBe('strategy');
    expect((plannerTask.output as { spawnTasks?: unknown[] })?.spawnTasks).toHaveLength(1);
    // Post-PR4: planner emits structuredOutput → report-writer renders prose.
    expect(plannerTask.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer, contains the prose it
        // generated — NOT a verbatim copy of structuredOutput.data.overview.
        report: expect.stringContaining('反向操作 SERP 悶熱恐懼'),
        body: expect.stringContaining('## 市場觀察'),
      },
      lastStructuredOutput: {
        schemaName: 'product-plan',
        data: expect.objectContaining({
          overview: expect.stringContaining('## 市場觀察'),
          variants: expect.arrayContaining([
            expect.objectContaining({ title: '亞麻短袖 - 電商版 (zh-TW)' }),
          ]),
        }),
        keyDecisions: expect.arrayContaining(['反向操作 SERP 悶熱恐懼，主打 180g 不悶']),
      },
    });

    // ── Phase 2: approve planner → spawns product-designer child ─────────────
    const approvePlanner = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${plannerTaskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approvePlanner.statusCode).toBe(200);

    const plannerChildren = await listTasks(tenantId, { parentTaskId: plannerTaskId });
    expect(plannerChildren).toHaveLength(1);
    const designerTaskId = plannerChildren[0]!.id;
    expect(plannerChildren[0]!.assignedAgent).toBe('product-designer');

    // ── Phase 3: product-designer runs ───────────────────────────────────────
    // Designer is single-pass: tool-loop with finalAnswer:ProductListingSchema,
    // model submits via submit_listing. No images scripted → no images_generate
    // hop, model goes straight to submit.
    scriptToolCall('submit_listing', {
      title: 'Linen Oversized Shirt',
      body: '## 主特色\n\n輕薄亞麻，台灣夏天通勤首選。\n\n- 不悶熱\n- 可機洗',
      tags: ['linen', 'summer', 'taiwan'],
      vendor: 'Acme',
      keyDecisions: [
        '機能透氣切「台灣濕熱通勤」實戰',
        '從 brief 推斷 Acme 為品牌；productType 留空',
      ],
      progressNote: '文案跟圖片都好了，老闆看一下',
    });
    // Report-writer LLM call for schemaName='product-listing'. NO extra
    // scriptStructured — supervisor short-circuits on awaitingApproval=true
    // (src/orchestrator/supervisor.ts:69-72).
    scriptText(
      '## 設計決定\n\n機能透氣切台灣濕熱通勤實戰。\n\n## 為什麼這樣選\n\n從 brief 切角直接連結痛點，避免抽象廣告語。',
    );

    await drainNextTask();
    const designerTask = await getTask(tenantId, designerTaskId);
    expect(designerTask.status).toBe('waiting');
    expect(designerTask.kind).toBe('strategy');
    expect((designerTask.output as { spawnTasks?: unknown[] })?.spawnTasks).toHaveLength(1);
    // Post-PR6: designer emits structuredOutput → report-writer renders prose.
    expect(designerTask.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer — prose-unique substring
        // '機能透氣切台灣濕熱通勤實戰' is ONLY in the scripted text above.
        // (The agent's keyDecisions[0] uses the slightly different phrase
        // '機能透氣切「台灣濕熱通勤」實戰' with quote marks — a copy of
        // keyDecisions or body to artifact.report would NOT match the
        // assertion's quote-free substring.)
        report: expect.stringContaining('機能透氣切台灣濕熱通勤實戰'),
        body: expect.stringContaining('## 主特色'),
      },
      lastStructuredOutput: {
        schemaName: 'product-listing',
        data: expect.objectContaining({
          title: 'Linen Oversized Shirt',
          body: expect.stringContaining('## 主特色'),
          tags: expect.arrayContaining(['linen']),
          vendor: 'Acme',
          language: expect.any(String),
        }),
        keyDecisions: expect.arrayContaining(['機能透氣切「台灣濕熱通勤」實戰']),
      },
    });

    // ── Phase 4: approve designer → spawns shopify-publisher child ────────────
    const approveDesigner = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${designerTaskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approveDesigner.statusCode).toBe(200);

    const designerChildren = await listTasks(tenantId, { parentTaskId: designerTaskId });
    expect(designerChildren).toHaveLength(1);
    const publisherTaskId = designerChildren[0]!.id;
    expect(designerChildren[0]!.assignedAgent).toBe('shopify-publisher');

    // ── Phase 5: shopify-publisher runs → waiting with pendingToolCall ─────────
    // Publisher agent sets up pendingToolCall (no Shopify API call until approve)
    // AND emits structuredOutput { schemaName: 'shopify-publish-intent' } →
    // report-writer fires once before the HITL gate. NO scriptStructured
    // because supervisor short-circuits on awaitingApproval=true
    // (src/orchestrator/supervisor.ts:69-72).
    scriptText(
      '## 上架前確認\n\n老闆，我把【Linen Oversized Shirt】整理好了，準備丟到 Shopify zh-TW 站。\n\n## 為什麼這樣選\n\n品牌 Acme，3 個標籤、1 張圖片，等你按確認就上線。',
    );

    await drainNextTask();
    const pubTask = await getTask(tenantId, publisherTaskId);
    expect(pubTask.status).toBe('waiting');
    expect((pubTask.output as { pendingToolCall?: { id: string } })?.pendingToolCall?.id).toBe(
      'shopify.create_product',
    );
    // Post-PR7: publisher emits structuredOutput → report-writer renders prose.
    expect(pubTask.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer — prose-unique substring
        // '上架前確認' is ONLY in the scripted text above; the agent's
        // keyDecisions never use that phrase, so a copy of keyDecisions to
        // artifact.report would NOT match this assertion.
        report: expect.stringContaining('上架前確認'),
        body: expect.stringContaining('## 主特色'),
        refs: expect.objectContaining({
          title: 'Linen Oversized Shirt',
          ready: true,
        }),
      },
      lastStructuredOutput: {
        schemaName: 'shopify-publish-intent',
        data: expect.objectContaining({
          title: 'Linen Oversized Shirt',
          vendor: 'Acme',
          tags: expect.arrayContaining(['linen']),
          language: 'zh-TW',
          imageCount: expect.any(Number),
        }),
        keyDecisions: expect.arrayContaining([expect.stringContaining('Linen Oversized Shirt')]),
      },
    });
    // bodyWithImages assertion (`/!\[圖 \d+\]/`) is intentionally NOT here:
    // this E2E doesn't script `images_generate`, so designer's imageUrls=[]
    // flows through and publisher correctly omits the image markdown block.
    // Boss-view image plumbing is covered by tests/shopify-publisher.test.ts
    // (the unit-level "invoke() maps ProductContent ..." spec).

    // ── Phase 6: approve publisher → fires shopify.create_product → done ──────
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ product: { id: 456, title: 'Linen Oversized Shirt' } }),
    } as unknown as Response);

    const approvePub = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${publisherTaskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approvePub.statusCode).toBe(200);

    const finalTask = await getTask(tenantId, publisherTaskId);
    expect(finalTask.status).toBe('done');
    expect(finalTask.output).toMatchObject({
      artifact: expect.objectContaining({
        report: expect.any(String),
        body: expect.any(String),
        refs: expect.objectContaining({
          ready: true,
          published: expect.objectContaining({ productId: 456 }),
        }),
      }),
      toolExecutedAt: expect.any(String),
    });

    // Validate the publisher → Shopify HTTP binding directly via fetchMock —
    // proves the title/body got out the door over the wire.
    const publishCall = fetchMock.mock.calls.find(([url]) => String(url).includes('products.json'));
    expect(publishCall).toBeDefined();
    const publishBody = JSON.parse(publishCall![1].body);
    expect(publishBody.product.title).toBe('Linen Oversized Shirt');
    expect(publishBody.product.body_html).toContain('<h2>主特色</h2>');
  });
});
