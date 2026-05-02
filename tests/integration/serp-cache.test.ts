import { describe, expect, it, vi } from 'vitest';
import { SerpCache } from '../../src/integrations/serper/cache.js';
import { SerperClient } from '../../src/integrations/serper/client.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';

describe('SerpCache', () => {
  it('hits Serper once, then serves from cache', async () => {
    await truncateAll();
    const { tenantId } = await seedTenantWithOwner();
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ organic: [], peopleAlsoAsk: [], relatedSearches: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const cache = new SerpCache(
      new SerperClient({ apiKey: 'k', fetchImpl: fakeFetch as unknown as typeof fetch }),
      { ttlMs: 1000 * 60 * 60 * 24 * 7 },
    );

    const a = await cache.search(tenantId, { query: 'Linen Shirts ', locale: 'en' });
    const b = await cache.search(tenantId, { query: 'linen shirts', locale: 'en' });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('refetches once expired', async () => {
    await truncateAll();
    const { tenantId } = await seedTenantWithOwner();
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ organic: [], peopleAlsoAsk: [], relatedSearches: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const cache = new SerpCache(
      new SerperClient({ apiKey: 'k', fetchImpl: fakeFetch as unknown as typeof fetch }),
      { ttlMs: -1 },
    );
    await cache.search(tenantId, { query: 'q' });
    await cache.search(tenantId, { query: 'q' });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });
});
