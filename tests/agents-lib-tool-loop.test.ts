import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * Verifies the runToolLoop's coercion-retry cap. The cap matters because each
 * "no tool_calls when finalAnswer is required" hop is a full LLM call, and
 * empirically (logs from tasks 5ff9a3ea / b3ac0433) models that ignore the
 * first nudge ignore subsequent ones too — burning the rest of maxHops on
 * identical retries is pure waste. Default is 1 (one nudge, then bail).
 */

const invokeMock = vi.fn();
const bindToolsMock = vi.fn(() => ({ invoke: invokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({ bindTools: bindToolsMock })),
}));

const { runToolLoop } = await import('../src/agents/lib/tool-loop.js');

const TestSchema = z.object({ value: z.string() });

const baseOpts = {
  modelConfig: { model: 'test/test', temperature: 0 },
  messages: [],
  tools: [],
  emitLog: vi.fn(async () => {}),
  finalAnswer: {
    schema: TestSchema,
    name: 'submit_test',
  },
};

describe('runToolLoop coercion retry cap', () => {
  it('bails after maxCoercionRetries=1 (default) — one nudge, then exit', async () => {
    invokeMock.mockReset();
    // Hop 0: model talks instead of calling submit. Loop nudges.
    // Hop 1: model still talks. Loop should bail (default cap=1).
    // Hop 2 onward must NOT be invoked.
    invokeMock
      .mockResolvedValueOnce(new AIMessage({ content: '研究完成，準備提交', tool_calls: [] }))
      .mockResolvedValueOnce(new AIMessage({ content: '稍等', tool_calls: [] }));

    const result = await runToolLoop({ ...baseOpts, maxHops: 8 });

    expect(result.kind).toBe('plain');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('honours custom maxCoercionRetries=0 — no nudges, bail immediately', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(new AIMessage({ content: '研究完成', tool_calls: [] }));

    const result = await runToolLoop({
      ...baseOpts,
      maxHops: 8,
      finalAnswer: { ...baseOpts.finalAnswer, maxCoercionRetries: 0 },
    });

    expect(result.kind).toBe('plain');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('honours custom maxCoercionRetries=2 — two nudges before bail', async () => {
    invokeMock.mockReset();
    invokeMock
      .mockResolvedValueOnce(new AIMessage({ content: 'a', tool_calls: [] }))
      .mockResolvedValueOnce(new AIMessage({ content: 'b', tool_calls: [] }))
      .mockResolvedValueOnce(new AIMessage({ content: 'c', tool_calls: [] }));

    const result = await runToolLoop({
      ...baseOpts,
      maxHops: 8,
      finalAnswer: { ...baseOpts.finalAnswer, maxCoercionRetries: 2 },
    });

    expect(result.kind).toBe('plain');
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it('successful submit after one nudge still works (recovery path)', async () => {
    invokeMock.mockReset();
    invokeMock
      .mockResolvedValueOnce(new AIMessage({ content: '準備提交', tool_calls: [] }))
      .mockResolvedValueOnce(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_1', name: 'submit_test', args: { value: 'recovered' } }],
        }),
      );

    const result = await runToolLoop({ ...baseOpts, maxHops: 8 });

    expect(result.kind).toBe('submitted');
    if (result.kind === 'submitted') {
      expect(result.value).toEqual({ value: 'recovered' });
    }
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
