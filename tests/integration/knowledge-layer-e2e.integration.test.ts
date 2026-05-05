import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import {
  clearScript,
  disableMessageCapture,
  enableMessageCapture,
  getCapturedMessages,
  llmMockModule,
  scriptStructured,
  scriptToolCall,
} from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

// Stub fetch — the writer may attempt Shopify calls on publish path; we don't
// need them to succeed for this test since publishToShopify is false.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { createTestApp } = await import('./helpers/app.js');
const { db } = await import('../../src/db/client.js');
const { tenants, tenantSkillPacks, tenantCredentials } = await import(
  '../../src/db/schema/index.js'
);
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
  disableMessageCapture();
  fetchMock.mockReset();
});

describe('knowledge layer e2e — profile + pack reach agent system prompt', () => {
  it('tenant profile and skill pack appear in the writer agent system prompt', async () => {
    // 1. Seed tenant with profile_md and timezone
    const { tenantId, userId, email } = await seedTenantWithOwner();
    await db
      .update(tenants)
      .set({
        profileMd: '## Brand voice\n\nWarm. Never use the word "synergy".',
        timezone: 'Asia/Taipei',
      })
      .where(eq(tenants.id, tenantId));

    // 2. Seed a tenant skill pack that applies to shopify-blog-writer
    await db.insert(tenantSkillPacks).values({
      tenantId,
      key: 'tenant.house-style',
      name: 'House Style',
      body: '## House style\n\nAlways close articles with a question.',
      appliesTo: ['shopify-blog-writer'],
    });

    // 3. Bind the Shopify credential (required by manifest regardless of publishToShopify)
    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_test_token',
      metadata: { storeUrl: 'demo-shop.myshopify.com' },
    });

    const jwt = await mintJwt({ userId, email });
    const hdrs = authHeaders(jwt, tenantId);

    // 4. Activate the writer with publishToShopify: false so no Shopify API calls needed
    const activateRes = await app.inject({
      method: 'POST',
      url: '/v1/agents/shopify-blog-writer/activate',
      headers: hdrs,
      payload: { config: { publishToShopify: false } },
    });
    expect(activateRes.statusCode).toBe(200);

    // 5. Enable capture, then script the LLM calls:
    //    - supervisor routes to shopify-blog-writer (withStructuredOutput)
    //    - writer produces article via submit_article tool call (bindTools)
    enableMessageCapture();
    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptToolCall('submit_article', {
      title: 'Linen Shirts Guide',
      body: '## Intro\n\nLinen shirts are cool.',
      summaryHtml: 'Guide to linen shirts.',
      tags: ['linen', 'shirts'],
      language: 'en',
      report: '## Angle\n\nFrom a comfort-first perspective.',
      progressNote: 'Draft done.',
    });

    // 6. Create a task through the API
    const taskRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: hdrs,
      payload: { brief: 'Write a post about linen shirts', agentId: 'shopify-blog-writer' },
    });
    expect(taskRes.statusCode).toBe(201);

    // 7. Run the task through the graph
    await drainNextTask();

    // 8. Assert the LLM received messages containing the tenant knowledge
    const invocations = getCapturedMessages();
    expect(invocations.length).toBeGreaterThan(0);

    // Flatten all message content across all invocations into one string.
    // LangChain messages are objects with a `content` string property.
    const allContent = invocations
      .flatMap((inv) => {
        const msgs = inv.messages;
        if (!Array.isArray(msgs)) return [JSON.stringify(msgs)];
        return msgs.map((m) => {
          if (typeof m === 'string') return m;
          if (typeof m === 'object' && m !== null && 'content' in m) {
            return String((m as { content: unknown }).content);
          }
          return JSON.stringify(m);
        });
      })
      .join('\n');

    // Assert tenant profile content is present in LLM calls
    expect(allContent).toContain('Brand voice');
    expect(allContent).toContain('synergy');
    expect(allContent).toContain('Asia/Taipei');

    // Assert skill pack content is present in LLM calls
    expect(allContent).toContain('House Style');
    expect(allContent).toContain('close articles with a question');
  });
});
