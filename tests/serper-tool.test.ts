import { describe, expect, it, vi } from 'vitest';
import { buildSerperTools } from '../src/integrations/serper/tools.js';

describe('buildSerperTools', () => {
  it('exposes serper.search tool that delegates to the cache', async () => {
    const search = vi.fn(async () => ({ organic: [], peopleAlsoAsk: ['?'], relatedSearches: [] }));
    const tools = buildSerperTools({ tenantId: 't1', cache: { search } as never });
    const tool = tools.find((t) => t.id === 'serper.search');
    expect(tool).toBeDefined();
    const result = await tool!.tool.invoke({ query: 'linen', locale: 'en' });
    expect(search).toHaveBeenCalledWith('t1', { query: 'linen', locale: 'en', num: 10 });
    expect(result).toEqual({ organic: [], peopleAlsoAsk: ['?'], relatedSearches: [] });
  });
});
