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

// Mock S3 SDK so the cover-image path (off by default but resolved at build())
// doesn't reach real infrastructure.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn(async () => ({})) })),
  PutObjectCommand: vi.fn(),
}));

// Dummy R2 + OpenAI env vars so blog-writer build() doesn't throw on missing config.
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

describe('report-writer wiring — zero behavior change for un-migrated agents', () => {
  it('an agent that does not emit structuredOutput still completes a HITL pause cleanly', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    // shopify-blog-writer (current, un-migrated) doesn't set structuredOutput.
    // It produces an article via submit_article — exactly as before this PR.
    scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
    scriptToolCall('submit_article', {
      title: 'Pre-refactor article',
      slug: 'pre-refactor-article',
      body: '## Body\n\nLong enough to satisfy the schema minimum body length for an SEO article.',
      summaryHtml: 'A summary that gives enough length for the schema minimum.',
      tags: ['demo'],
      language: 'en',
      report: '## Decision\n\nThis report comes from the agent itself, not the new report-writer.',
      progressNote: 'Draft done.',
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'pre-refactor regression check' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    const task = await getTask(tenantId, taskId);
    // Critical invariants for "zero behavior change":
    //   - task reaches waiting (HITL gate fired correctly through report-writer)
    //   - artifact.report is the agent's own output (NOT overwritten by report-writer)
    //   - task.output.lastStructuredOutput is absent (the agent didn't emit it)
    expect(task.status).toBe('waiting');
    const output = task.output as Record<string, unknown> | null;
    expect((output?.artifact as { report?: string } | undefined)?.report).toContain(
      'This report comes from the agent itself',
    );
    expect(output).not.toHaveProperty('lastStructuredOutput');
  });
});
