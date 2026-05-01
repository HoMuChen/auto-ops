import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import {
  clearScript,
  llmMockModule,
  pendingScript,
  scriptStructured,
  scriptText,
} from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());

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
});

describe('Strategy → Spawn → Execution flow', () => {
  it('strategist plans, finalize spawns children, each child runs through HITL', async () => {
    // Strategist is gated to pro+ — seed accordingly.
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'pro' });
    const jwt = await mintJwt({ userId, email });

    // ── Phase 1: parent strategy task ──────────────────────────────────────
    // Supervisor picks the strategist (one structured call), then the
    // strategist itself returns a structured content plan (second structured
    // call). No text completion is needed because the agent uses
    // withStructuredOutput end-to-end.
    scriptStructured({
      nextAgent: 'seo-strategist',
      clarification: null,
      done: false,
    });
    scriptStructured({
      reasoning: 'Three-pronged plan covering core summer keyword clusters.',
      topics: [
        {
          title: '夏季穿搭 5 個必備單品',
          primaryKeyword: '夏季穿搭',
          language: 'zh-TW',
          writerBrief:
            '1500 字 long-form article on layered summer styling for humid Taiwan climate.',
        },
        {
          title: 'Sustainable summer fabrics buyer guide',
          primaryKeyword: 'sustainable fabrics summer',
          language: 'en',
          writerBrief: 'Buyer guide comparing linen, organic cotton and Tencel for summer apparel.',
        },
      ],
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'Plan the summer SEO campaign for our store' },
    });
    expect(create.statusCode).toBe(201);
    const parentId = create.json().id as string;

    // Drive the worker to run the strategy task.
    const drained = await drainNextTask();
    expect(drained.taskId).toBe(parentId);

    let parent = await getTask(tenantId, parentId);
    expect(parent.status).toBe('waiting');
    // Runner should auto-promote kind because the agent emitted spawnTasks.
    expect(parent.kind).toBe('strategy');
    // The plan and the pending children specs should both be in output.
    expect(parent.output).toMatchObject({
      plan: { topics: expect.any(Array) },
      spawnTasks: expect.arrayContaining([
        expect.objectContaining({ assignedAgent: 'seo-writer' }),
      ]),
    });

    // No children spawned yet — they appear only on finalize-approve.
    const beforeApprove = await listTasks(tenantId, { parentTaskId: parentId });
    expect(beforeApprove).toHaveLength(0);

    // ── Phase 2: approve(finalize=true) → spawn ────────────────────────────
    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${parentId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    parent = await getTask(tenantId, parentId);
    expect(parent.status).toBe('done');
    // Idempotency markers stamped.
    expect(parent.output).toMatchObject({
      spawnedAt: expect.any(String),
      spawnedTaskIds: expect.arrayContaining([expect.any(String)]),
    });

    const children = await listTasks(tenantId, { parentTaskId: parentId });
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.kind).toBe('execution');
      expect(child.assignedAgent).toBe('seo-writer');
      expect(child.status).toBe('todo');
      expect(child.input).toHaveProperty('brief');
    }

    // ── Phase 3: idempotent re-approve (network retry) ─────────────────────
    // Calling approve again on a done strategy task currently throws because
    // the state machine refuses done → done. The repository's idempotency
    // safeguard is for `finalizeStrategyTask` itself, not the approve route.
    // Confirm no duplicate children if we manually call the helper twice.
    const { finalizeStrategyTask } = await import('../../src/tasks/repository.js');
    const replay = await finalizeStrategyTask(tenantId, parentId);
    expect(replay.children).toHaveLength(2);
    const stillTwo = await listTasks(tenantId, { parentTaskId: parentId });
    expect(stillTwo).toHaveLength(2);

    // ── Phase 4: drain children — supervisor LLM is BYPASSED via pinning ───
    // Each child has assignedAgent='seo-writer' so the supervisor short-circuits;
    // only the writer's text completion needs to be scripted.
    expect(pendingScript()).toBe(0);
    scriptText('# Article 1 draft');
    scriptText('# Article 2 draft');

    const c1 = await drainNextTask();
    expect(c1.claimed).toBe(true);
    const c2 = await drainNextTask();
    expect(c2.claimed).toBe(true);

    for (const child of children) {
      const refreshed = await getTask(tenantId, child.id);
      expect(refreshed.status).toBe('waiting');
      expect(refreshed.output).toMatchObject({ draft: expect.stringContaining('Article') });
    }

    // ── Phase 5: approve each child as final ───────────────────────────────
    for (const child of children) {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${child.id}/approve`,
        headers: authHeaders(jwt, tenantId),
        payload: { finalize: true },
      });
      expect(r.statusCode).toBe(200);
      const final = await getTask(tenantId, child.id);
      expect(final.status).toBe('done');
    }
  });
});
