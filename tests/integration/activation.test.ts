import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import { clearScript, llmMockModule } from './helpers/llm-mock.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

const { createTestApp } = await import('./helpers/app.js');

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
});

describe('Agent activation flow', () => {
  it('shopify-publisher is not ready until the Shopify credential is bound', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });

    // Inspect publisher agent — should report a missing Shopify credential.
    let detail = await app
      .inject({
        method: 'GET',
        url: '/v1/agents/shopify-publisher',
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());

    expect(detail.id).toBe('shopify-publisher');
    expect(detail.enabled).toBe(false);
    expect(detail.ready).toBe(false);
    expect(detail.credentials).toEqual([
      expect.objectContaining({ provider: 'shopify', bound: false }),
    ]);

    // Activating now should fail with 409 + a "missing credentials" detail.
    const earlyActivate = await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-publisher/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: {} },
    });
    expect(earlyActivate.statusCode).toBe(409);
    expect(earlyActivate.json().error.message).toMatch(/shopify/i);

    // Bind a Shopify credential.
    const putCred = await app.inject({
      method: 'PUT',
      url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: {
        secret: 'shpat_test_secret',
        metadata: { storeUrl: 'demo.myshopify.com' },
      },
    });
    expect(putCred.statusCode).toBe(200);

    // Now ready should flip to true.
    detail = await app
      .inject({
        method: 'GET',
        url: '/v1/agents/shopify-publisher',
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    expect(detail.ready).toBe(true);
    expect(detail.credentials[0]).toMatchObject({ provider: 'shopify', bound: true });

    // Activate writes the agent_configs row.
    const activate = await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-publisher/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: {
          shopify: { autoPublish: true },
        },
      },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json()).toMatchObject({
      enabled: true,
      config: {
        shopify: expect.objectContaining({ autoPublish: true }),
      },
    });

    // GET reflects the persisted config + enabled flag.
    detail = await app
      .inject({
        method: 'GET',
        url: '/v1/agents/shopify-publisher',
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    expect(detail.enabled).toBe(true);
    expect(detail.config).toMatchObject({
      shopify: expect.objectContaining({ autoPublish: true }),
    });
  });

  it('rejects an invalid config with 400 and Zod field errors', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });

    // Bind credential first so the failure is purely about config validation.
    await app.inject({
      method: 'PUT',
      url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: { secret: 's', metadata: { storeUrl: 'demo.myshopify.com' } },
    });

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-publisher/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        // autoPublish must be boolean, not a string
        config: { shopify: { autoPublish: 'yes' } },
      },
    });
    expect(bad.statusCode).toBe(400);
    const body = bad.json();
    expect(body.error.code).toBe('validation_error');
    // Zod-formatted details should mention the shopify field.
    expect(JSON.stringify(body.error.details)).toMatch(/shopify/);
  });

  it('shopify-blog-writer requires Shopify credentials (it publishes blog articles on approve)', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });

    // Without credentials: ready=false because the publish_article tool needs Shopify.
    let detail = await app
      .inject({
        method: 'GET',
        url: '/v1/agents/shopify-blog-writer',
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());

    expect(detail.requiredCredentials).toEqual([expect.objectContaining({ provider: 'shopify' })]);
    expect(detail.ready).toBe(false);

    const earlyActivate = await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-blog-writer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { targetLanguages: ['zh-TW', 'en'] } },
    });
    expect(earlyActivate.statusCode).toBe(409);

    // Bind Shopify creds → activation succeeds.
    await app.inject({
      method: 'PUT',
      url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: { secret: 'shpat_x', metadata: { storeUrl: 'demo.myshopify.com' } },
    });

    detail = await app
      .inject({
        method: 'GET',
        url: '/v1/agents/shopify-blog-writer',
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    expect(detail.ready).toBe(true);

    const activate = await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-blog-writer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { targetLanguages: ['zh-TW', 'en'] } },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().config.targetLanguages).toEqual(['zh-TW', 'en']);
  });

  it('deactivate flips enabled but preserves config', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });

    // shopify-blog-writer needs Shopify creds bound before activation.
    await app.inject({
      method: 'PUT',
      url: '/v1/credentials/shopify',
      headers: authHeaders(jwt, tenantId),
      payload: { secret: 'shpat_x', metadata: { storeUrl: 'demo.myshopify.com' } },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-blog-writer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: { config: { targetLanguages: ['ja'] } },
    });

    const deactivate = await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-blog-writer/deactivate',
      headers: authHeaders(jwt, tenantId),
    });
    expect(deactivate.statusCode).toBe(204);

    const detail = await app
      .inject({
        method: 'GET',
        url: '/v1/agents/shopify-blog-writer',
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    expect(detail.enabled).toBe(false);
    expect(detail.config).toMatchObject({ targetLanguages: ['ja'] });
  });
});
