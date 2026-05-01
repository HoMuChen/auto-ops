import { describe, expect, it } from 'vitest';
import { buildRuntimeContext } from '../src/orchestrator/runtime-context.js';

describe('buildRuntimeContext', () => {
  it('emits a labelled "Runtime context" block with a current ISO timestamp', () => {
    const block = buildRuntimeContext();
    expect(block.startsWith('Runtime context:')).toBe(true);
    expect(block).toMatch(/- Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('ends with a "---" separator + blank line so the agent prompt sits below', () => {
    const block = buildRuntimeContext();
    expect(block.endsWith('---\n\n')).toBe(true);
  });

  it('returns a fresh timestamp on each call (rebuilt per worker pickup)', async () => {
    const a = buildRuntimeContext();
    await new Promise((r) => setTimeout(r, 5));
    const b = buildRuntimeContext();
    expect(a).not.toBe(b);
  });
});
