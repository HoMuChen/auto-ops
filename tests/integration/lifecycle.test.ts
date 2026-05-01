import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import { clearScript, llmMockModule, scriptStructured, scriptText } from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

// Replace the real model registry BEFORE any module under test imports it.
vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

// Imports that depend on the mocked module:
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
});

describe('Task lifecycle — happy path through HITL gate', () => {
  it('POST /conversations → worker runs → waiting → /approve(finalize) → done', async () => {
    // Seed tenant + owner, mint JWT.
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });

    // Script the supervisor + agent for one full graph turn:
    //   1. Supervisor routes to seo-expert.
    //   2. seo-expert returns a draft. The agent code sets awaitingApproval=true.
    scriptStructured({
      nextAgent: 'seo-expert',
      clarification: null,
      done: false,
    });
    scriptText('# Summer Dresses Buying Guide\n\nDraft body…');

    // 1. Dispatch the brief.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'Write an SEO article about summer dresses' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/i);

    // Sanity: status is todo, scheduled for the worker.
    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('todo');

    // 2. Drive one worker tick. Should claim, run the graph, hit the HITL gate.
    const drained = await drainNextTask();
    expect(drained.claimed).toBe(true);
    expect(drained.taskId).toBe(taskId);

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    // Output payload from the agent should be persisted.
    expect(task.output).toMatchObject({ draft: expect.stringContaining('Summer Dresses') });
    // Lock should be released so an approve+re-claim works.
    expect(task.lockedBy).toBeNull();

    // The agent's reply should be appended as an assistant message.
    const messages = await app
      .inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/messages`,
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);

    // Logs should include the HITL emit from the agent + the runner's
    // task.waiting line.
    const logs = await app
      .inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/logs`,
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    const events = logs.map((l: { event: string }) => l.event);
    expect(events).toContain('agent.draft.ready');
    expect(events).toContain('task.waiting');

    // 3. Approve as final answer.
    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('done');
    expect(task.completedAt).not.toBeNull();
  });

  it('non-finalize approve re-queues the task to todo (waiting → todo transition)', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });

    scriptStructured({ nextAgent: 'seo-expert', clarification: null, done: false });
    scriptText('# First draft');

    const create = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'something' },
    });
    const taskId = create.json().id as string;
    await drainNextTask();

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');

    // Approve WITHOUT finalize → should re-queue, not finalise.
    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: false },
    });
    expect(approve.statusCode).toBe(200);

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('todo');
    expect(task.completedAt).toBeNull();
  });

  it('feedback re-queues with the new user message visible to the agent', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner();
    const jwt = await mintJwt({ userId, email });

    scriptStructured({ nextAgent: 'seo-expert', clarification: null, done: false });
    scriptText('# First draft');

    const create = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'first brief' },
    });
    const taskId = create.json().id as string;
    await drainNextTask();

    const feedback = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/feedback`,
      headers: authHeaders(jwt, tenantId),
      payload: { feedback: 'Make the tone more playful' },
    });
    expect(feedback.statusCode).toBe(200);

    const task = await getTask(tenantId, taskId);
    expect(task.status).toBe('todo');

    const messages = await app
      .inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/messages`,
        headers: authHeaders(jwt, tenantId),
      })
      .then((r) => r.json());
    // user, assistant, user (feedback)
    expect(messages.map((m: { role: string; content: string }) => m.content)).toEqual([
      'first brief',
      '# First draft',
      'Make the tone more playful',
    ]);
  });
});
