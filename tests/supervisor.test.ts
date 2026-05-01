import { describe, expect, it, vi } from 'vitest';

/**
 * Verifies C1 fix: when the graph re-enters the supervisor with
 * `awaitingApproval=true`, it must short-circuit without overwriting the
 * gate flag.
 *
 * Mock the registry + model registry so the test is hermetic — no DB, no LLM.
 */

vi.mock('../src/agents/registry.js', () => ({
  agentRegistry: {
    // listForTenant should NOT be called when awaitingApproval is true.
    listForTenant: vi.fn(async () => {
      throw new Error('listForTenant must not be called during HITL gate');
    }),
  },
}));

const buildModelMock = vi.fn(() => {
  throw new Error('buildModel must not be called during HITL gate');
});

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: buildModelMock,
}));

const { runSupervisor } = await import('../src/orchestrator/supervisor.js');

describe('runSupervisor — HITL gate handling (C1)', () => {
  it('short-circuits when state.awaitingApproval is true', async () => {
    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [],
      params: {},
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: null,
      awaitingApproval: true,
    };

    const result = await runSupervisor(state);

    // Must NOT clear the gate; reducer is replace-only so {} preserves it.
    expect(result).toEqual({});
    expect(buildModelMock).not.toHaveBeenCalled();
  });
});

describe('runSupervisor — pinned-agent shortcut (execution children)', () => {
  it('routes directly to pinnedAgent on first hop without an LLM call', async () => {
    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [],
      params: {},
      nextAgent: null,
      pinnedAgent: 'shopify-blog-writer',
      lastOutput: null,
      awaitingApproval: false,
    };

    const result = await runSupervisor(state);

    expect(result).toEqual({ nextAgent: 'shopify-blog-writer' });
    // No registry lookup, no model call — pure deterministic routing.
    expect(buildModelMock).not.toHaveBeenCalled();
  });
});
