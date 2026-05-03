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
import { clearScript, llmMockModule, scriptStructured } from './helpers/llm-mock.js';
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
    // Planner Pass 1 = bindTools (no serper key → empty tools, returns no tool_calls automatically)
    // Planner Pass 2 = withStructuredOutput(PlanSchema)
    scriptStructured({
      reasoning: 'One Shopify variant for zh-TW e-commerce.',
      summary: '規劃了 1 個電商版本，主打台灣市場通勤族，老闆確認一下',
      progressNote: '規劃好了，1 個 variant，老闆看一下',
      variants: [
        {
          title: '亞麻短袖 - 電商版 (zh-TW)',
          platform: 'shopify',
          language: 'zh-TW',
          marketingAngle: '機能透氣，台灣濕熱夏天通勤族',
          keyMessages: ['180g 亞麻不悶熱', '可機洗'],
          copyBrief: {
            tone: 'warm, professional',
            featuresToHighlight: ['fabric weight', 'washability'],
            forbiddenClaims: [],
          },
          imagePlan: [
            { purpose: 'hero shot', styleHint: 'clean white background', priority: 'required' },
          ],
          assignedAgent: 'product-designer',
        },
      ],
    });

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
    // Designer Pass 1 = bindTools (no tool_calls scripted → loop exits immediately, no images generated)
    // Designer Pass 2 = withStructuredOutput(ProductListingSchema)
    scriptStructured({
      title: 'Linen Oversized Shirt',
      bodyHtml: '<p>輕薄亞麻，台灣夏天通勤首選。</p>',
      tags: ['linen', 'summer', 'taiwan'],
      vendor: 'Acme',
      progressNote: '文案跟圖片都好了，老闆看一下',
    });

    await drainNextTask();
    const designerTask = await getTask(tenantId, designerTaskId);
    expect(designerTask.status).toBe('waiting');
    expect(designerTask.kind).toBe('strategy');
    expect((designerTask.output as { spawnTasks?: unknown[] })?.spawnTasks).toHaveLength(1);

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
    // Publisher agent sets up pendingToolCall only — no Shopify API call until approve.
    await drainNextTask();
    const pubTask = await getTask(tenantId, publisherTaskId);
    expect(pubTask.status).toBe('waiting');
    expect((pubTask.output as { pendingToolCall?: { id: string } })?.pendingToolCall?.id).toBe(
      'shopify.create_product',
    );

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
    expect(finalTask.output).toMatchObject({ toolResult: expect.anything() });
  });
});
