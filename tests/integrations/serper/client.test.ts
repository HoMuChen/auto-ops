import { describe, expect, it, vi } from 'vitest';
import { SerperClient } from '../../../src/integrations/serper/client.js';

describe('SerperClient', () => {
  it('POSTs the right body and parses Serper response into our typed shape', async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            organic: [{ title: 'A', link: 'https://a', snippet: 's', position: 1 }],
            peopleAlsoAsk: [{ question: 'Why?' }],
            relatedSearches: [{ query: 'foo bar' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new SerperClient({
      apiKey: 'k',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const result = await client.search({ query: 'linen shirts', locale: 'en' });

    expect(fakeFetch).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-API-KEY': 'k' }),
        body: expect.stringContaining('"q":"linen shirts"'),
      }),
    );
    expect(result.organic).toEqual([{ title: 'A', url: 'https://a', snippet: 's', position: 1 }]);
    expect(result.peopleAlsoAsk).toEqual(['Why?']);
    expect(result.relatedSearches).toEqual(['foo bar']);
  });

  it('throws on non-2xx with the body included', async () => {
    const fakeFetch = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const client = new SerperClient({
      apiKey: 'k',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(client.search({ query: 'x' })).rejects.toThrow(/429/);
  });
});
