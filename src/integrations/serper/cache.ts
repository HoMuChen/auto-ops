import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { serpCache } from '../../db/schema/index.js';
import type { SerperClient, SerperSearchInput, SerperSearchResult } from './client.js';

export interface SerpCacheOpts {
  /** Cache TTL in ms; default 7 days. Negative for "always expired" (testing). */
  ttlMs?: number;
}

export class SerpCache {
  private readonly ttlMs: number;

  constructor(
    private readonly client: SerperClient,
    opts: SerpCacheOpts = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 1000 * 60 * 60 * 24 * 7;
  }

  async search(tenantId: string, input: SerperSearchInput): Promise<SerperSearchResult> {
    const queryHash = this.hash(input.query);
    const locale = input.locale ?? '';
    const now = new Date();

    const [hit] = await db
      .select()
      .from(serpCache)
      .where(
        and(
          eq(serpCache.tenantId, tenantId),
          eq(serpCache.queryHash, queryHash),
          eq(serpCache.locale, locale),
          gt(serpCache.expiresAt, now),
        ),
      )
      .limit(1);
    if (hit) return hit.payload as SerperSearchResult;

    const fresh = await this.client.search(input);
    await db
      .insert(serpCache)
      .values({
        tenantId,
        queryHash,
        locale,
        payload: fresh,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + this.ttlMs),
      })
      .onConflictDoUpdate({
        target: [serpCache.tenantId, serpCache.queryHash, serpCache.locale],
        set: { payload: fresh, fetchedAt: now, expiresAt: new Date(now.getTime() + this.ttlMs) },
      });
    return fresh;
  }

  private hash(query: string): string {
    return createHash('sha256').update(query.trim().toLowerCase()).digest('hex');
  }
}
