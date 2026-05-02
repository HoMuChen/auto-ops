import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import { clearScript, llmMockModule, scriptStructured } from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

// Stub global fetch so the Shopify client's REST call is intercepted without
// hitting the real API. Verifies the wire format end-to-end.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { createTestApp } = await import('./helpers/app.js');
const { getTask } = await import('../../src/tasks/repository.js');

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

describe('Shopify Ops end-to-end (text only, no images)', () => {
  it('drafts listing → waiting → approve(finalize) → fires create_product → done with productId', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    // Bind a Shopify credential so the activation gate clears.
    const putCred = await app.inject({
      method: 'PUT',
      url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: {
        secret: 'shpat_test_token',
        metadata: { storeUrl: 'demo-shop.myshopify.com' },
      },
    });
    expect(putCred.statusCode).toBe(200);

    // Activate the agent.
    const activate = await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-ops/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: {
          shopify: { defaultVendor: 'Acme', autoPublish: false },
          defaultLanguage: 'zh-TW',
        },
      },
    });
    expect(activate.statusCode).toBe(200);

    // Script the LLM responses for one full graph turn:
    //   1. Supervisor → routes to shopify-ops.
    //   2. shopify-ops → produces a structured listing (withStructuredOutput).
    scriptStructured({
      nextAgent: 'shopify-ops',
      clarification: null,
      done: false,
    });
    scriptStructured({
      title: 'Linen summer shirt',
      bodyHtml: '<p>Breathable, lightweight linen shirt for hot summer days.</p>',
      tags: ['summer', 'linen', 'shirt'],
      vendor: 'Acme Apparel',
      progressNote: 'Listing 整理好了，主打透氣材質，老闆過目',
    });

    // Dispatch the brief.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'List a summer linen shirt on Shopify' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    // Worker tick → graph runs → HITL gate.
    await drainNextTask();

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.output).toMatchObject({
      listing: { title: 'Linen summer shirt', vendor: 'Acme Apparel' },
      pendingToolCall: {
        id: 'shopify.create_product',
        args: expect.objectContaining({ title: 'Linen summer shirt' }),
      },
    });
    // No Shopify call yet — agent only proposes.
    expect(fetchMock).not.toHaveBeenCalled();

    // Stub the Shopify Admin REST response for create_product.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => '',
      json: async () => ({
        product: { id: 9876543210, handle: 'linen-summer-shirt' },
      }),
    } as unknown as Response);

    // Approve(finalize=true) — should fire the deferred tool.
    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    // Verify the wire call to Shopify.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://demo-shop.myshopify.com/admin/api/2024-10/products.json');
    expect(init.method).toBe('POST');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toMatchObject({
      product: {
        title: 'Linen summer shirt',
        body_html: expect.stringContaining('linen shirt'),
        tags: expect.arrayContaining(['summer']),
        vendor: 'Acme Apparel',
        status: 'draft', // autoPublish=false
      },
    });
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(
      'shpat_test_token',
    );

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('done');
    expect(task.output).toMatchObject({
      // Listing payload preserved.
      listing: { title: 'Linen summer shirt' },
      // Tool result stamped by the executor.
      toolResult: {
        productId: 9876543210,
        handle: 'linen-summer-shirt',
        adminUrl: 'https://demo-shop.myshopify.com/admin/products/9876543210',
        status: 'draft',
      },
      toolExecutedAt: expect.any(String),
    });
    expect(task.completedAt).not.toBeNull();
  });

  it('Shopify failure → task marked failed, error persisted', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await app.inject({
      method: 'PUT',
      url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: {
        secret: 'shpat_test_token',
        metadata: { storeUrl: 'demo-shop.myshopify.com' },
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-ops/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: {
          shopify: { defaultVendor: 'Acme', autoPublish: false },
          defaultLanguage: 'zh-TW',
        },
      },
    });

    scriptStructured({ nextAgent: 'shopify-ops', clarification: null, done: false });
    scriptStructured({
      title: 'Bad item',
      bodyHtml: '<p>nope</p>',
      tags: ['x'],
      vendor: 'Acme',
      progressNote: 'Listing 草擬好了，但這次資訊偏少',
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'list a thing' },
    });
    const taskId = create.json().id as string;
    await drainNextTask();

    // Shopify returns 422.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => '{"errors":{"title":["is invalid"]}}',
      json: async () => ({}),
    } as unknown as Response);

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    // Executor throws the upstream error → reaches the global error handler.
    expect(approve.statusCode).toBeGreaterThanOrEqual(500);

    const task = await getTask(tenantId, taskId);
    expect(task.status).toBe('failed');
    expect(task.error?.message).toMatch(/Shopify API 422/);
  });
});

describe('Shopify Ops — image generation on auto-generate', () => {
  it('generates product image when cfg.images.autoGenerate=true (default), includes images in pendingToolCall', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await app.inject({
      method: 'PUT',
      url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: { secret: 'shpat_test_token', metadata: { storeUrl: 'demo-shop.myshopify.com' } },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-ops/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: {
          shopify: { defaultVendor: 'Acme', autoPublish: false },
          defaultLanguage: 'zh-TW',
          images: { autoGenerate: true, style: 'white background' },
        },
      },
    });

    scriptStructured({ nextAgent: 'shopify-ops', clarification: null, done: false });
    scriptStructured({
      title: 'Canvas Sneakers',
      bodyHtml: '<p>Clean canvas sneakers for everyday wear.</p>',
      tags: ['shoes', 'canvas'],
      vendor: 'Acme Shoes',
      progressNote: 'Listing 整理好了',
    });

    // fetchMock handles: 1) OpenAI image generation, 2) CF upload
    const fakeImageB64 = Buffer.from('fakeimg').toString('base64');
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: fakeImageB64 }] }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            id: 'cf-prod-img',
            variants: ['https://imagedelivery.net/HASH/cf-prod-img/public'],
          },
        }),
      } as unknown as Response);

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'List canvas sneakers on Shopify' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    const task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.output).toMatchObject({
      pendingToolCall: {
        id: 'shopify.create_product',
        args: expect.objectContaining({
          title: 'Canvas Sneakers',
          images: expect.arrayContaining([
            expect.objectContaining({ url: expect.stringContaining('imagedelivery.net') }),
          ]),
        }),
      },
    });
  });
});
