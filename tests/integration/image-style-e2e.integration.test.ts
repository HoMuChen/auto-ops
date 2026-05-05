import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import {
  clearScript,
  llmMockModule,
  scriptStructured,
  scriptToolCall,
} from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

// Spy on OpenAI image generation BEFORE importing anything that builds tools.
const generateSpy = vi.fn(async () => Buffer.from('fake-image'));
vi.mock('../../src/integrations/openai-images/client.js', async (orig) => {
  const actual = await orig<typeof import('../../src/integrations/openai-images/client.js')>();
  class MockOpenAIImagesClient extends actual.OpenAIImagesClient {
    override generate = generateSpy;
  }
  return { ...actual, OpenAIImagesClient: MockOpenAIImagesClient };
});

// Stub R2/Cloudflare uploads via S3-compat client.
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

// Stub fetch so Shopify API calls don't hit the network.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { createTestApp } = await import('./helpers/app.js');
const { db } = await import('../../src/db/client.js');
const { tenants } = await import('../../src/db/schema/index.js');
const { eq } = await import('drizzle-orm');

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
  generateSpy.mockClear();
  fetchMock.mockReset();
});

describe('image style e2e', () => {
  it('tenant.image_style_suffix appears verbatim in OpenAI generate prompt', async () => {
    const MARKER = 'TENANT_STYLE_MARKER_2026';

    const { tenantId, userId, email } = await seedTenantWithOwner();
    await db.update(tenants).set({ imageStyleSuffix: MARKER }).where(eq(tenants.id, tenantId));

    const jwt = await mintJwt({ userId, email });
    const hdrs = authHeaders(jwt, tenantId);

    // Bind Shopify credential for the publisher (required by publisher manifest).
    await app.inject({
      method: 'PUT',
      url: '/v1/credentials/shopify',
      headers: hdrs,
      payload: { secret: 'shpat_test', metadata: { storeUrl: 'demo.myshopify.com' } },
    });

    // Activate product-designer and shopify-publisher (designer requires at least one publisher).
    await app.inject({
      method: 'POST',
      url: '/v1/agents/product-designer/activate',
      headers: hdrs,
      payload: { config: {} },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-publisher/activate',
      headers: hdrs,
      payload: { config: {} },
    });

    // Script the LLM calls:
    // 1. Supervisor routes to product-designer.
    scriptStructured({ nextAgent: 'product-designer', clarification: null, done: false });
    // 2. Designer's first tool-loop hop: generate an image.
    scriptToolCall('images_generate', { prompt: 'minimalist hero shot of a linen shirt' });
    // 3. Designer's second hop: submit the final listing.
    scriptToolCall('submit_listing', {
      title: 'Linen Shirt',
      body: '## Hero Shot\n\nClean product photography on white background.',
      tags: ['linen', 'shirt', 'summer'],
      vendor: 'Acme',
      report: '## 切角\n\n機能透氣。\n\n## 圖片選擇\n\n白底主圖。',
      progressNote: '圖文都好了，老闆看一下',
    });

    // Create the task pinned to product-designer.
    const taskRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: hdrs,
      payload: {
        brief: 'Design a hero shot for our linen shirt',
        agentId: 'product-designer',
      },
    });
    expect(taskRes.statusCode).toBe(201);

    await drainNextTask();

    // The generateSpy must have been called at least once.
    expect(generateSpy).toHaveBeenCalled();

    // The prompt passed to OpenAI must include the LLM-provided text AND the tenant style suffix.
    const firstCall = generateSpy.mock.calls[0]?.[0] as { prompt: string } | undefined;
    expect(firstCall?.prompt).toContain('linen shirt');
    expect(firstCall?.prompt).toContain(`Style: ${MARKER}`);
  });
});
