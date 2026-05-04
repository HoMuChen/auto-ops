import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

/**
 * Verifies C1 fix: when the graph re-enters the supervisor with
 * `awaitingApproval=true`, it must short-circuit without overwriting the
 * gate flag.
 *
 * Mock the registry + model registry so the test is hermetic — no DB, no LLM.
 */

const listForTenantMock = vi.fn(async () => {
  throw new Error('listForTenant must not be called during HITL gate');
});

vi.mock('../src/agents/registry.js', () => ({
  agentRegistry: {
    listForTenant: listForTenantMock,
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
      currentTaskOutput: null,
      taskImageIds: null,
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
      currentTaskOutput: null,
      taskImageIds: null,
    };

    const result = await runSupervisor(state);

    expect(result).toEqual({ nextAgent: 'shopify-blog-writer' });
    // No registry lookup, no model call — pure deterministic routing.
    expect(buildModelMock).not.toHaveBeenCalled();
  });
});

/**
 * Regression: a clarification from the supervisor must be persisted through
 * the same path agents use (lastOutput) so the runner writes it to
 * `messages`/`tasks.output`. Previously the clarification only survived in
 * LangGraph's checkpoint blob, leaving the user staring at a status flip with
 * no visible message.
 *
 * Also: the message added to the channel must be an AIMessage, not a
 * HumanMessage — otherwise the next supervisor turn would re-feed the
 * supervisor's own question back as a fake user follow-up.
 */
describe('runSupervisor — clarification path persists through lastOutput', () => {
  it('fills lastOutput and tags the channel message as AI', async () => {
    listForTenantMock.mockReset();
    buildModelMock.mockReset();
    listForTenantMock.mockResolvedValueOnce([
      { manifest: { id: 'shopify-blog-writer', description: 'writes one Shopify blog article' } },
    ] as never);

    const invokeMock = vi.fn(async () => ({
      nextAgent: null,
      clarification: 'Could you clarify the target language?',
      done: false,
    }));
    buildModelMock.mockImplementation(
      () =>
        ({
          withStructuredOutput: () => ({ invoke: invokeMock }),
        }) as never,
    );

    const state = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [],
      params: { brief: 'Write something' },
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: null,
      awaitingApproval: false,
      currentTaskOutput: null,
      taskImageIds: null,
    };

    const result = await runSupervisor(state);

    expect(result.awaitingApproval).toBe(true);
    expect(result.nextAgent).toBeNull();
    expect(result.lastOutput).toEqual({
      agentId: 'supervisor',
      message: 'Could you clarify the target language?',
      artifact: {
        report: expect.stringContaining('Could you clarify the target language?'),
      },
    });
    expect(result.messages).toHaveLength(1);
    const [msg] = result.messages ?? [];
    expect(msg).toBeInstanceOf(AIMessage);
    expect(msg?.content).toBe('[supervisor] Could you clarify the target language?');
  });
});

/**
 * Regression: every LLM call (supervisor + each agent) must receive the
 * runtime context block — currently just `Current time`, but the universal
 * insertion point for future tenant/industry/timezone facts. Without this,
 * "every 3 days" / "next week" type asks have no anchor.
 */
describe('runSupervisor — runtime context injected into system message', () => {
  it('prepends the Runtime context block to the supervisor system prompt', async () => {
    listForTenantMock.mockReset();
    buildModelMock.mockReset();
    listForTenantMock.mockResolvedValueOnce([
      { manifest: { id: 'shopify-blog-writer', description: 'fake' } },
    ] as never);

    let capturedMessages: { content: string }[] | null = null;
    const invokeMock = vi.fn(async (msgs: { content: string }[]) => {
      capturedMessages = msgs;
      return { nextAgent: 'shopify-blog-writer', clarification: null, done: false };
    });
    buildModelMock.mockImplementation(
      () =>
        ({
          withStructuredOutput: () => ({ invoke: invokeMock }),
        }) as never,
    );

    await runSupervisor({
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [],
      params: { brief: 'Write something about linen' },
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: null,
      awaitingApproval: false,
      currentTaskOutput: null,
      taskImageIds: null,
    });

    expect(invokeMock).toHaveBeenCalledOnce();
    const systemMsg = capturedMessages![0]!;
    expect(systemMsg.content).toMatch(/^Runtime context:\n- Current time: \d{4}-\d{2}-\d{2}T/);
    // The original SUPERVISOR_PROMPT must still be present after the block.
    expect(systemMsg.content).toContain('You are the Supervisor');
  });
});

/**
 * Orchestrator awareness: when an agent has produced lastOutput, the
 * supervisor must surface that progress in its prompt so it can decide
 * "done" or "next agent" — instead of re-dispatching the same agent based
 * on the unchanged user brief.
 */
describe('runSupervisor — post-execution progress awareness', () => {
  it('includes lastOutput in the prompt and finishes when the LLM says done', async () => {
    listForTenantMock.mockReset();
    buildModelMock.mockReset();
    listForTenantMock.mockResolvedValueOnce([
      { manifest: { id: 'market-researcher', description: 'fake' } },
    ] as never);

    let capturedMessages: { content: string }[] | null = null;
    const invokeMock = vi.fn(async (msgs: { content: string }[]) => {
      capturedMessages = msgs;
      return { nextAgent: null, clarification: null, done: true };
    });
    buildModelMock.mockImplementation(
      () =>
        ({
          withStructuredOutput: () => ({ invoke: invokeMock }),
        }) as never,
    );

    const result = await runSupervisor({
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: '00000000-0000-0000-0000-000000000002',
      messages: [],
      params: { brief: '調查寵物用品市場' },
      nextAgent: null,
      pinnedAgent: null,
      lastOutput: {
        agentId: 'market-researcher',
        message: '已產出市場研究報告，涵蓋競品分析與市場缺口。',
      },
      awaitingApproval: false,
      currentTaskOutput: null,
      taskImageIds: null,
    });

    expect(invokeMock).toHaveBeenCalledOnce();
    const humanMsg = capturedMessages![1]!;
    expect(humanMsg.content).toContain('Work done so far:');
    expect(humanMsg.content).toContain('market-researcher: 已產出市場研究報告');
    expect(result).toEqual({ nextAgent: null, awaitingApproval: false });
  });
});
