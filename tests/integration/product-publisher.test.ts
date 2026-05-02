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
const { getTask } = await import('../../src/tasks/repository.js');

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => { app = await createTestApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(); clearScript(); fetchMock.mockReset(); });

describe('product-strategist → shopify-publisher end-to-end', () => {
  it('generates content → approve → spawns publisher → approve → create_product', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    // Bind Shopify credential for the publisher
    await app.inject({
      method: 'PUT', url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: { secret: 'shpat_test', metadata: { storeUrl: 'demo.myshopify.com' } },
    });

    // Activate both agents
    await app.inject({
      method: 'POST', url: '/v1/agents/product-strategist/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { defaultLanguage: 'zh-TW', defaultVendor: 'Acme' } },
    });
    await app.inject({
      method: 'POST', url: '/v1/agents/shopify-publisher/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: {} },
    });

    // Script: supervisor routes → product-strategist, then LLM produces listing
    scriptStructured({ nextAgent: 'product-strategist', clarification: null, done: false });
    scriptStructured({
      title: 'Linen Shirt', bodyHtml: '<p>Cool.</p>',
      tags: ['linen'], vendor: 'Acme', progressNote: '商品文案好了',
    });

    // OpenAI image generation mock
    const fakeImageB64 = Buffer.from('fakeimg').toString('base64');
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ data: [{ b64_json: fakeImageB64 }] }),
    } as unknown as Response);

    // Create task
    const create = await app.inject({
      method: 'POST', url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'List this linen shirt' },
    });
    expect(create.statusCode).toBe(201);
    const stratTaskId = create.json().id as string;

    // Strategist runs → waiting with spawnTasks
    await drainNextTask();
    const stratTask = await getTask(tenantId, stratTaskId);
    expect(stratTask.status).toBe('waiting');
    expect(stratTask.kind).toBe('strategy');
    expect((stratTask.output as { spawnTasks?: unknown[] })?.spawnTasks).toHaveLength(1);

    // Approve(finalize) → spawns shopify-publisher child
    const approveStrat = await app.inject({
      method: 'POST', url: `/v1/tasks/${stratTaskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approveStrat.statusCode).toBe(200);

    // Find the spawned publisher child
    const listTasks = await app.inject({
      method: 'GET', url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
    });
    const allTasks = listTasks.json<{ id: string; assignedAgent: string; status: string }[]>();
    const publisherTask = allTasks.find((t) => t.assignedAgent === 'shopify-publisher');
    expect(publisherTask).toBeDefined();

    // Publisher runs → waiting with pendingToolCall
    await drainNextTask();
    const pubTask = await getTask(tenantId, publisherTask!.id);
    expect(pubTask.status).toBe('waiting');
    expect((pubTask.output as { pendingToolCall?: { id: string } })?.pendingToolCall?.id).toBe(
      'shopify.create_product',
    );

    // Mock Shopify product creation
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ product: { id: 123, title: 'Linen Shirt' } }),
    } as unknown as Response);

    // Approve(finalize) → fires shopify.create_product
    const approvePub = await app.inject({
      method: 'POST', url: `/v1/tasks/${publisherTask!.id}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approvePub.statusCode).toBe(200);

    const finalTask = await getTask(tenantId, publisherTask!.id);
    expect(finalTask.status).toBe('done');
    expect(finalTask.output).toMatchObject({ toolResult: expect.anything() });
  });
});
