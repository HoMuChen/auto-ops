# SEO Agents Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Upgrade `seo-strategist` and `shopify-blog-writer` so the Strategist plans articles backed by real Serper SERP research, and the Writer asks the boss EEAT-grounding questions before drafting.

**Architecture:** Strategist gets a `serper.search` tool (with a 7-day Postgres cache) and emits a structured `research` block per topic; Writer runs a two-stage flow (questions → waiting → draft → waiting). SEO knowledge ships as markdown skill packs concatenated into the system prompt — no RAG, no embeddings.

**Design Doc:** `docs/plans/2026-05-02-seo-agents-upgrade-design.md`

**Tech Stack:** Fastify 5 · Drizzle ORM (Postgres via Supabase) · LangGraph.js · LangChain · Zod · Vitest · OpenRouter · Serper.dev

**Discipline:** TDD where the unit has behaviour. Mock-friendly seams (fetch, db). Frequent commits — each task ends with one commit.

**Read existing patterns first:**
- `src/integrations/shopify/tools.ts` — how a tool integration is wired
- `src/agents/builtin/shopify-blog-writer/index.ts` — agent build/invoke shape (I just refactored it; clean baseline)
- `tests/integration/helpers/llm-mock.ts` — `scriptStructured(data)` / `scriptText(text)` queue
- `tests/integration/lifecycle.test.ts` — full task lifecycle integration pattern
- `src/db/schema/credentials.ts` — minimal jsonb table example
- `src/tasks/output.ts` — TaskOutput type to extend

---

## Section A — Serper integration foundations

### Task 1: Add `serp_cache` table

**Files:**
- Create: `src/db/schema/serp_cache.ts`
- Modify: `src/db/schema/index.ts`

**Step 1: Write the schema**

```ts
// src/db/schema/serp_cache.ts
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * 7-day SERP cache. Key is (tenant_id, query_hash, locale) — same query on
 * different locales is a different cache entry. payload stores the parsed
 * Serper response in our typed shape (see SerperSearchResult).
 */
export const serpCache = pgTable(
  'serp_cache',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    queryHash: text('query_hash').notNull(),
    locale: text('locale').notNull().default(''),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: index('serp_cache_pk').on(table.tenantId, table.queryHash, table.locale),
    expiresIdx: index('serp_cache_expires_idx').on(table.expiresAt),
  }),
);

export type SerpCacheRow = typeof serpCache.$inferSelect;
export type NewSerpCacheRow = typeof serpCache.$inferInsert;
```

**Step 2: Re-export**

In `src/db/schema/index.ts`, append: `export * from './serp_cache.js';`

**Step 3: Generate + apply migration**

```bash
pnpm db:generate
pnpm db:migrate
```

**Step 4: Verify**

```bash
psql "$DATABASE_URL" -c "\d serp_cache" | head
```
Expected: table with `tenant_id`, `query_hash`, `locale`, `payload`, `fetched_at`, `expires_at`.

**Step 5: Commit**

```bash
git add src/db/schema/serp_cache.ts src/db/schema/index.ts drizzle/
git commit -m "feat(db): add serp_cache table for SERP research caching"
```

---

### Task 2: Wire `SERPER_API_KEY` into env config

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`

**Step 1: Read current env.ts**, add `SERPER_API_KEY: z.string().min(1).optional()` to the schema, exporting it via the env helper. Optional because tests don't need it; the client throws at first call if missing.

**Step 2: Append to `.env.example`:**

```
# Serper.dev SERP API (https://serper.dev). Strategist agent uses this for
# keyword research. v1: platform-wide single key absorbed by the platform.
SERPER_API_KEY=
```

**Step 3: Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "feat(config): add SERPER_API_KEY env var"
```

---

### Task 3: Serper client (TDD)

**Files:**
- Create: `src/integrations/serper/client.ts`
- Test: `tests/integrations/serper/client.test.ts`

The client is a thin wrapper around `fetch` posting to `https://google.serper.dev/search`. Inject `fetch` via constructor parameter so tests can mock without monkey-patching globals.

**Step 1: Write the failing test**

```ts
// tests/integrations/serper/client.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SerperClient } from '../../../src/integrations/serper/client.js';

describe('SerperClient', () => {
  it('POSTs the right body and parses Serper response into our typed shape', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          organic: [{ title: 'A', link: 'https://a', snippet: 's', position: 1 }],
          peopleAlsoAsk: [{ question: 'Why?' }],
          relatedSearches: [{ query: 'foo bar' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new SerperClient({ apiKey: 'k', fetchImpl: fakeFetch as unknown as typeof fetch });
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
    const client = new SerperClient({ apiKey: 'k', fetchImpl: fakeFetch as unknown as typeof fetch });
    await expect(client.search({ query: 'x' })).rejects.toThrow(/429/);
  });
});
```

**Step 2: Run — expect fail (module not found)**

```bash
pnpm test -- tests/integrations/serper/client.test.ts
```

**Step 3: Implement the client**

```ts
// src/integrations/serper/client.ts
import { z } from 'zod';

export const SerperSearchResultSchema = z.object({
  organic: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), position: z.number() })),
  peopleAlsoAsk: z.array(z.string()),
  relatedSearches: z.array(z.string()),
  knowledgeGraph: z.unknown().optional(),
  answerBox: z.unknown().optional(),
});

export type SerperSearchResult = z.infer<typeof SerperSearchResultSchema>;

export interface SerperSearchInput {
  query: string;
  locale?: string;          // 'en', 'zh-tw' — maps to Serper's `gl`
  num?: number;             // default 10
}

export class SerperClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: { apiKey: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async search(input: SerperSearchInput): Promise<SerperSearchResult> {
    const body: Record<string, unknown> = { q: input.query, num: input.num ?? 10 };
    if (input.locale) body.gl = input.locale.split('-')[0]?.toLowerCase();
    const res = await this.fetchImpl('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': this.opts.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Serper ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      organic?: { title: string; link: string; snippet: string; position: number }[];
      peopleAlsoAsk?: { question: string }[];
      relatedSearches?: { query: string }[];
      knowledgeGraph?: unknown;
      answerBox?: unknown;
    };
    return SerperSearchResultSchema.parse({
      organic: (json.organic ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet, position: r.position })),
      peopleAlsoAsk: (json.peopleAlsoAsk ?? []).map((p) => p.question),
      relatedSearches: (json.relatedSearches ?? []).map((r) => r.query),
      ...(json.knowledgeGraph ? { knowledgeGraph: json.knowledgeGraph } : {}),
      ...(json.answerBox ? { answerBox: json.answerBox } : {}),
    });
  }
}
```

**Step 4: Run — expect pass**

```bash
pnpm test -- tests/integrations/serper/client.test.ts
```

**Step 5: Commit**

```bash
git add src/integrations/serper tests/integrations/serper
git commit -m "feat(serper): add typed SERP client with injectable fetch"
```

---

### Task 4: SERP cache layer (TDD, integration test)

**Files:**
- Create: `src/integrations/serper/cache.ts`
- Test: `tests/integration/serper-cache.test.ts`

The cache wraps a `SerperClient` and a tenant id; on `search()` it consults `serp_cache` first. Hash is `sha256(query.trim().toLowerCase()) → hex`.

**Step 1: Write the failing integration test**

```ts
// tests/integration/serper-cache.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SerpCache } from '../../src/integrations/serper/cache.js';
import { SerperClient } from '../../src/integrations/serper/client.js';
import { resetDb, seedTenant } from './helpers/db.js';

describe('SerpCache', () => {
  it('hits Serper once, then serves from cache', async () => {
    await resetDb();
    const tenant = await seedTenant();
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ organic: [], peopleAlsoAsk: [], relatedSearches: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const cache = new SerpCache(
      new SerperClient({ apiKey: 'k', fetchImpl: fakeFetch as unknown as typeof fetch }),
      { ttlMs: 1000 * 60 * 60 * 24 * 7 },
    );

    const a = await cache.search(tenant.id, { query: 'Linen Shirts ', locale: 'en' });
    const b = await cache.search(tenant.id, { query: 'linen shirts', locale: 'en' });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('refetches once expired', async () => {
    await resetDb();
    const tenant = await seedTenant();
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ organic: [], peopleAlsoAsk: [], relatedSearches: [] }), { status: 200 }),
    );
    const cache = new SerpCache(
      new SerperClient({ apiKey: 'k', fetchImpl: fakeFetch as unknown as typeof fetch }),
      { ttlMs: -1 }, // already expired
    );
    await cache.search(tenant.id, { query: 'q' });
    await cache.search(tenant.id, { query: 'q' });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });
});
```

(`seedTenant` already exists in `tests/integration/helpers/db.ts` — reuse; if its signature differs, adapt the test to it.)

**Step 2: Run — expect fail**

```bash
pnpm test:integration -- tests/integration/serp-cache.test.ts
```

**Step 3: Implement the cache**

```ts
// src/integrations/serper/cache.ts
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
  constructor(private readonly client: SerperClient, opts: SerpCacheOpts = {}) {
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
```

You'll need a unique constraint for `onConflictDoUpdate` — adjust Task 1's schema to include `primaryKey({ columns: [tenantId, queryHash, locale] })` instead of an index on those columns, then re-run `pnpm db:generate && pnpm db:migrate`. Update Task 1's commit if not yet pushed; otherwise add a follow-up migration.

**Step 4: Run — expect pass**

```bash
pnpm test:integration -- tests/integration/serp-cache.test.ts
```

**Step 5: Commit**

```bash
git add src/integrations/serper/cache.ts tests/integration/serp-cache.test.ts
git add src/db/schema/serp_cache.ts drizzle/   # if schema changed
git commit -m "feat(serper): add tenant-scoped SERP cache with 7d TTL"
```

---

### Task 5: `serper.search` LangChain tool

**Files:**
- Create: `src/integrations/serper/tools.ts`
- Test: `tests/serper-tool.test.ts`

**Step 1: Write the test**

```ts
// tests/serper-tool.test.ts
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
```

**Step 2: Run — expect fail**

**Step 3: Implement**

```ts
// src/integrations/serper/tools.ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentTool } from '../../agents/types.js';
import type { SerpCache } from './cache.js';

export const SERPER_TOOL_IDS = ['serper.search'] as const;

export interface BuildSerperToolsOptions {
  tenantId: string;
  cache: SerpCache;
}

export function buildSerperTools(opts: BuildSerperToolsOptions): AgentTool[] {
  const search = tool(
    async (input: { query: string; locale?: string; num?: number }) => {
      const result = await opts.cache.search(opts.tenantId, {
        query: input.query,
        ...(input.locale ? { locale: input.locale } : {}),
        num: input.num ?? 10,
      });
      return result;
    },
    {
      name: 'serper_search',
      description:
        'Search Google via Serper. Returns top organic results, People Also Ask questions, ' +
        'and related searches. Use this for SEO keyword research and competitor SERP analysis.',
      schema: z.object({
        query: z.string().min(2).describe('The search query (a specific keyword phrase).'),
        locale: z.string().optional().describe('Optional locale, e.g. "en", "zh-tw".'),
        num: z.number().int().min(1).max(20).optional().describe('Number of organic results, default 10.'),
      }),
    },
  );
  return [{ id: 'serper.search', tool: search }];
}
```

**Step 4: Run — expect pass**

**Step 5: Commit**

```bash
git add src/integrations/serper/tools.ts tests/serper-tool.test.ts
git commit -m "feat(serper): add serper.search LangChain tool"
```

---

## Section B — Skill packs

### Task 6: Pack loader (TDD)

**Files:**
- Create: `src/agents/lib/packs.ts`
- Test: `tests/packs.test.ts`
- Test fixtures: `tests/fixtures/packs/seo-fundamentals.md`, `tests/fixtures/packs/eeat.md`, `tests/fixtures/packs/disabled.md`

**Step 1: Write the test**

```ts
// tests/packs.test.ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPacks } from '../src/agents/lib/packs.js';

const dir = path.resolve(__dirname, 'fixtures/packs');

describe('loadPacks', () => {
  it('includes only enabled packs and renders them with versioned headings', async () => {
    const out = await loadPacks(dir, { seoFundamentals: true, eeat: true, disabled: false });
    expect(out).toMatch(/## Skill: SEO Fundamentals \(v1\)/);
    expect(out).toMatch(/## Skill: EEAT Discipline \(v2\)/);
    expect(out).not.toMatch(/disabled/i);
  });

  it('returns empty string when nothing enabled', async () => {
    const out = await loadPacks(dir, { seoFundamentals: false, eeat: false });
    expect(out).toBe('');
  });
});
```

**Fixture file contents** (test markdown — will write these now so the loader can be exercised):

`tests/fixtures/packs/seo-fundamentals.md`:
```markdown
---
key: seoFundamentals
name: SEO Fundamentals
version: 1
---
Title length 50–60 chars.
```

`tests/fixtures/packs/eeat.md`:
```markdown
---
key: eeat
name: EEAT Discipline
version: 2
---
Ground every claim in personal experience.
```

`tests/fixtures/packs/disabled.md`:
```markdown
---
key: disabled
name: Should Not Appear
version: 1
---
This must never reach the prompt.
```

**Step 2: Run — expect fail**

**Step 3: Implement**

```ts
// src/agents/lib/packs.ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

interface ParsedPack {
  key: string;
  name: string;
  version: string | number;
  body: string;
}

async function readPack(filePath: string): Promise<ParsedPack | null> {
  const raw = await readFile(filePath, 'utf8');
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const fmRaw = match[1] ?? '';
  const body = (match[2] ?? '').trim();
  const fm: Record<string, string> = {};
  for (const line of fmRaw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) fm[k] = v;
  }
  if (!fm.key || !fm.name || !fm.version) return null;
  return { key: fm.key, name: fm.name, version: fm.version, body };
}

/**
 * Load and concatenate enabled packs from `dir/*.md`. Each pack file must have
 * frontmatter with `key`, `name`, `version`. Packs whose `key` is not in
 * `enabled` (or set to false) are skipped. Output order is the alphabetical
 * filename order — deterministic.
 */
export async function loadPacks(
  dir: string,
  enabled: Record<string, boolean>,
): Promise<string> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  const sections: string[] = [];
  for (const file of files) {
    const parsed = await readPack(path.join(dir, file));
    if (!parsed) continue;
    if (!enabled[parsed.key]) continue;
    sections.push(`## Skill: ${parsed.name} (v${parsed.version})\n\n${parsed.body}`);
  }
  return sections.join('\n\n');
}
```

**Step 4: Run — expect pass**

**Step 5: Commit**

```bash
git add src/agents/lib/packs.ts tests/packs.test.ts tests/fixtures/packs
git commit -m "feat(agents): add markdown skill-pack loader"
```

---

### Task 7: Write `seo-fundamentals.md` (shared by both agents)

**Files:**
- Create: `src/agents/builtin/seo-strategist/packs/seo-fundamentals.md`
- Create: `src/agents/builtin/shopify-blog-writer/packs/seo-fundamentals.md` (same content; copy)

**Content (paste verbatim into both files):**

```markdown
---
key: seoFundamentals
name: SEO Fundamentals
version: 1
---
Title: 50–60 chars. Front-load the primary keyword. One H1 per page.

Heading hierarchy: H2 sections answer search intent variants (often the PAA
questions). H3 only as sub-points of an H2. Skipping levels (H2 → H4) is a
crawl-quality smell.

Meta description: 140–160 chars. Active voice. Includes the primary keyword
naturally — never keyword-stuffed.

Primary keyword density 0.5–1.5%. Secondary keywords (related searches,
synonyms, semantic neighbours) sprinkled across H2s and the first 100 words.

Internal links: 3–6 per article, anchor text descriptive (not "click here").
Outbound links: 1–3 to authoritative sources where you make non-trivial claims.

Image alt text: descriptive sentence including the keyword when natural; never
"image1.jpg" or "image of...".

URL slugs: short, hyphen-separated, lowercase. Strip stopwords. Match the
primary keyword shape, not the title verbatim.

Mobile readability: paragraphs ≤ 4 sentences. Use lists, blockquotes, tables
for skim-ability. Above-the-fold content must answer the title within the
first 100 words.
```

**Step:** Commit.

```bash
git add src/agents/builtin/seo-strategist/packs/seo-fundamentals.md \
        src/agents/builtin/shopify-blog-writer/packs/seo-fundamentals.md
git commit -m "feat(packs): add SEO fundamentals skill pack"
```

---

### Task 8: Write `eeat.md` (Writer-only)

**Files:**
- Create: `src/agents/builtin/shopify-blog-writer/packs/eeat.md`

**Content:**

```markdown
---
key: eeat
name: EEAT Discipline
version: 1
---
EEAT = Experience, Expertise, Authoritativeness, Trustworthiness. For e-commerce
content, the dimension we cannot fake is **Experience** — the boss's hands-on
familiarity with the product or use-case.

Before drafting, you ASK the boss for experience signals when:
1. The brief is for a "best", "guide", "how-to", "review", or "vs." piece.
2. The eeatHook from the strategist explicitly flags an experience gap.
3. The topic involves wearability / tactile feel / longevity / regional fit /
   season-specific use — anything Google's quality raters score on first-hand
   knowledge.

The questions you ask must be:
- **Concrete** — "How many washes before the linen pilling started?" beats
  "Tell me about the linen quality."
- **Few** — never more than 5. 2–3 is the sweet spot.
- **Skippable** — mark `optional: true` for nice-to-have details so the boss
  can finish a thinking session without finishing every answer.

When the answers come back, weave them into the draft:
- Direct quotes when colourful: "客人試穿說『涼到不像麻』".
- First-person stories ("我自己穿過台北 35 度的午後") in the intro or one
  pivotal H2 — never every section, or it reads like a diary.
- Specific numbers always (washes, hours worn, customer count) — they signal
  experience harder than adjectives.

Trust signals that are NOT experience but still help:
- Cite first-party data ("過去 3 個月 482 筆訂單顯示…") when the boss provides
  it.
- Link out to authoritative sources (textile institutes, government health
  guidelines) for non-obvious claims.
- Disclose limits ("我們沒測過 -10°C 以下的耐寒度") when relevant.

Avoid the EEAT anti-patterns:
- Generic AI prose ("In today's fast-paced world...").
- Faking experience ("我穿了三年" when the boss didn't say so).
- Over-claiming authority ("醫學證實" without a real source).
```

**Step:** Commit.

```bash
git add src/agents/builtin/shopify-blog-writer/packs/eeat.md
git commit -m "feat(packs): add EEAT discipline skill pack for the writer"
```

---

## Section C — Strategist upgrade

### Task 9: Extend `TopicSchema` with research fields

**Files:**
- Modify: `src/agents/builtin/seo-strategist/index.ts`
- Modify: `tests/seo-strategist.test.ts` (existing — update fixtures)

**Step 1: Update existing tests first (TDD-ish; the schema change is the contract)**

In `tests/seo-strategist.test.ts`, find the scripted plan fixture and add the new fields to each topic. Example diff (locate the fixture object, extend it):

```ts
{
  title: 'Linen for hot summer',
  primaryKeyword: 'linen shirt',
  language: 'zh-TW',
  writerBrief: '...',
  assignedAgent: 'shopify-blog-writer',
  // NEW
  searchIntent: 'commercial',
  paaQuestions: ['Is linen good for summer?', 'How to care for linen?'],
  relatedSearches: ['linen vs cotton', 'best linen shirts 2026'],
  competitorTopAngles: ['fabric guides', 'comparison listicles'],
  competitorGaps: ['no Taiwan-specific humidity advice'],
  targetWordCount: 1200,
  eeatHook: 'Boss should share own washing/wearing experience in tropical humidity',
}
```

**Step 2: Run — expect fail (existing tests still pass; new schema invalid)**

```bash
pnpm test -- tests/seo-strategist.test.ts
```

**Step 3: Update `PlanSchema` in `src/agents/builtin/seo-strategist/index.ts`**

Locate the topics zod schema and add the new fields:

```ts
const TopicSchema = z.object({
  title: z.string().min(1),
  primaryKeyword: z.string(),
  language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
  writerBrief: z.string().min(20),
  assignedAgent: z.string(),
  scheduledAt: z.string().datetime().optional(),
  // NEW
  searchIntent: z.enum(['informational', 'commercial', 'transactional', 'navigational']),
  paaQuestions: z.array(z.string()).max(8),
  relatedSearches: z.array(z.string()).max(10),
  competitorTopAngles: z.array(z.string()).max(5),
  competitorGaps: z.array(z.string()).max(5),
  targetWordCount: z.number().int().min(400).max(4000),
  eeatHook: z.string().min(20).max(300),
});
```

(Replace the existing inline definition; the surrounding `PlanSchema` and `ContentTopic` types stay.)

**Step 4: Run — expect pass**

**Step 5: Commit**

```bash
git add src/agents/builtin/seo-strategist/index.ts tests/seo-strategist.test.ts
git commit -m "feat(seo-strategist): expand TopicSchema with SERP research fields"
```

---

### Task 10: Strategist build wires `serper.search` tool + `SerpCache`

**Files:**
- Modify: `src/agents/builtin/seo-strategist/index.ts`
- Modify: `src/config/env.ts` (export `SERPER_API_KEY` if not already)

**Step 1: In Strategist `build()`, instantiate the cache + tools**

Add near the top of `build()`:

```ts
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
import { env } from '../../../config/env.js';

// inside build()
const serperKey = env.SERPER_API_KEY;
if (!serperKey) {
  throw new Error('seo-strategist requires SERPER_API_KEY env var to be set');
}
const cache = new SerpCache(new SerperClient({ apiKey: serperKey }));
const serperTools = buildSerperTools({ tenantId: ctx.tenantId, cache });
```

Then expose `serperTools` in the runnable `tools[]` (currently `tools: []`):

```ts
return { tools: serperTools, invoke };
```

Update `manifest.toolIds` to include `'serper.search'`.

**Step 2: Update Strategist prompt to instruct LLM to call the tool**

Append to `DEFAULT_PROMPT`:

```
Workflow:
1. Identify 1–3 seed keyword clusters from the brief.
2. Call serper_search for each seed (and for any sub-cluster you want to validate).
3. Use the SERP results — top 10 titles, peopleAlsoAsk, relatedSearches — to:
   - Decide each topic's searchIntent.
   - Set paaQuestions = the most relevant 3–8 PAA items per topic.
   - Set relatedSearches = adjacent long-tail queries to weave in.
   - Set competitorTopAngles = patterns in the top 10 (e.g. "listicle of 7",
     "comparison guide", "tutorial").
   - Set competitorGaps = angles the top 10 ignore (the differentiation hook).
   - Set targetWordCount = roughly the median word count visible in top 10
     snippets (estimate; default 1200 if uncertain).
   - Set eeatHook = a 1-sentence note for the writer on which experience
     dimension matters most for this topic.
4. Only after research, build the structured plan.
```

**Step 3: This must use a non-`withStructuredOutput` LLM that supports tool calls**

LangGraph's structured-output model can't make tool calls + return a structured plan in one shot. Adopt a two-pass pattern in `invoke()`:

```ts
import { AIMessage } from '@langchain/core/messages';

// Pass 1: tool-calling LLM gathers SERP data.
const toolModel = buildModel(ctx.modelConfig).bindTools(
  serperTools.map((t) => t.tool),
);
const toolMessages = buildAgentMessages(ctx.systemPrompt, input.messages, constraints);

// Loop: invoke → if tool_calls → execute → append tool message → re-invoke; max 6 hops.
const collected: BaseMessage[] = [...toolMessages];
for (let hop = 0; hop < 6; hop++) {
  const res = (await toolModel.invoke(collected)) as AIMessage;
  collected.push(res);
  if (!res.tool_calls?.length) break;
  for (const call of res.tool_calls) {
    const t = serperTools.find((x) => x.tool.name === call.name);
    if (!t) continue;
    const result = await t.tool.invoke(call.args);
    collected.push(new ToolMessage({ tool_call_id: call.id!, content: JSON.stringify(result) }));
  }
}

// Pass 2: same conversation, but force structured plan output.
const planModel = buildModel(ctx.modelConfig).withStructuredOutput(PlanSchema, { name: 'seo_content_plan' });
const plan = (await planModel.invoke([...collected, new HumanMessage('Now produce the final structured plan.')])) as ContentPlan;
```

(Imports: `BaseMessage`, `HumanMessage`, `ToolMessage` from `@langchain/core/messages`.)

**Step 4: Update existing scripted tests for the two-pass pattern**

The integration test must script BOTH the tool-calling pass AND the structured pass. Use `scriptText` for the tool-call pass (returns AIMessage with tool_calls) and `scriptStructured` for the plan. If the existing mock helper doesn't support `tool_calls` in `scriptText`, extend it minimally (one-shot helper) — see `tests/integration/helpers/llm-mock.ts`.

**Step 5: Run — expect pass after fixture updates**

```bash
pnpm test -- tests/seo-strategist.test.ts
pnpm test:integration -- tests/integration/spawning.test.ts
```

**Step 6: Commit**

```bash
git add src/agents/builtin/seo-strategist src/config/env.ts tests/
git commit -m "feat(seo-strategist): wire serper.search and two-pass research→plan flow"
```

---

### Task 11: Strategist loads packs into system prompt

**Files:**
- Modify: `src/agents/builtin/seo-strategist/index.ts`

**Step 1: Add `skills` to the configSchema**

```ts
skills: z
  .object({
    seoFundamentals: z.boolean().default(true),
    aiSeo: z.boolean().default(true),
    geo: z.boolean().default(true),
  })
  .default({}),
```

**Step 2: In `build()`, load packs and prepend to systemPrompt**

```ts
import { loadPacks } from '../../lib/packs.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
const packsBlock = await loadPacks(packsDir, cfg.skills);
const systemPrompt = packsBlock
  ? `${packsBlock}\n\n${ctx.systemPrompt}`
  : ctx.systemPrompt;
```

(Pass `systemPrompt` into `buildAgentMessages` instead of `ctx.systemPrompt`.)

**Step 3: Update tests** — assert that when default cfg, the rendered system prompt contains `## Skill: SEO Fundamentals`.

**Step 4: Run — expect pass**

**Step 5: Commit**

```bash
git add src/agents/builtin/seo-strategist tests/seo-strategist.test.ts
git commit -m "feat(seo-strategist): load SEO/AI-SEO/GEO skill packs into system prompt"
```

---

## Section D — Writer upgrade

### Task 12: Extend `TaskOutput` with `eeatPending`

**Files:**
- Modify: `src/tasks/output.ts`

**Step:** Append to the interface:

```ts
eeatPending?: {
  questions: { question: string; hint?: string; optional?: boolean }[];
  askedAt: string;
};
```

Commit:

```bash
git add src/tasks/output.ts
git commit -m "feat(tasks): type eeatPending on TaskOutput"
```

---

### Task 13: `EeatQuestionsSchema` definition + Stage 1 invoke

**Files:**
- Modify: `src/agents/builtin/shopify-blog-writer/index.ts`

**Step 1: Define the schema near `ArticleSchema`**

```ts
const EeatQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(5).describe('Concrete experience question to the boss.'),
        hint: z.string().optional().describe('Optional hint shown under the question.'),
        optional: z.boolean().optional().describe('If true, boss may skip without blocking.'),
      }),
    )
    .min(1)
    .max(5),
  progressNote: z.string().min(10).max(200),
});
type EeatQuestions = z.infer<typeof EeatQuestionsSchema>;
```

**Step 2: Add stage-detection helper** at module scope:

```ts
function shouldDoStage1(task: { output?: unknown }, history: AgentInput['messages']): boolean {
  const out = (task.output ?? {}) as { eeatPending?: { askedAt: string } };
  if (!out.eeatPending) return true;
  const askedAt = Date.parse(out.eeatPending.askedAt);
  return !history.some((m) => m.role === 'user' && Date.now() > askedAt && Date.parse((m as unknown as { createdAt?: string }).createdAt ?? '0') > askedAt);
}
```

This is awkward because `AgentInput.messages` doesn't carry timestamps today. Simpler: have the runner pass `task.output` AND treat "stage 2" as "any user message in history *after* the assistant's pending-question turn". The most reliable signal is to count: if the most recent assistant message in history is the questions turn (i.e. the last AIMessage was the question payload), and there is at least one user message after it, we're in stage 2.

**Practical implementation:** the runner persists the questions as the assistant's turn (it already does, via `appendMessage`). So `history` ends with `assistant` (questions). When boss replies via `/feedback`, `history` ends with `user`. Detection becomes:

```ts
function shouldDoStage1(task: { output?: unknown }, history: AgentInput['messages']): boolean {
  const out = (task.output ?? {}) as { eeatPending?: unknown };
  if (!out.eeatPending) return true;
  // eeatPending exists → we already asked. Stage 2 if the last message is from user.
  return history[history.length - 1]?.role !== 'user';
}
```

**Step 3: Branch `invoke`**

Replace the current single-shot model invocation with:

```ts
const stage1 = shouldDoStage1({ output: undefined /* TODO: thread task.output */ }, input.messages);
```

**Step 4: Thread `task.output` to the agent**

The agent currently doesn't receive `task.output`. Add it via `AgentInput`:

In `src/agents/types.ts` extend `AgentInput`:
```ts
export interface AgentInput {
  messages: { role: ...; content: string }[];
  params: Record<string, unknown>;
  /** The task's persisted output, if the worker is resuming after a HITL gate. */
  taskOutput?: Record<string, unknown>;
}
```

In `src/orchestrator/graph.ts` (the agent node), pass `taskOutput`:
```ts
// Read from state's lastOutput.payload OR persist task.output through the runner.
// Simpler: read from the DB inside the node — repository already has getTask.
```

Cleanest: at the runner layer, fetch `task.output` and pass it as a graph state field, then forward in the node call:

In `src/orchestrator/state.ts`, add `currentTaskOutput: Record<string, unknown> | null` to GraphStateAnnotation.

In `src/tasks/runner.ts`, when seeding `invokeInput`, include `currentTaskOutput: task.output ?? null`.

In `src/orchestrator/graph.ts`, inside the agent node, pass `taskOutput: state.currentTaskOutput ?? undefined`.

**Step 5: Stage 1 invoke**

```ts
if (stage1) {
  const model = buildModel(ctx.modelConfig).withStructuredOutput(EeatQuestionsSchema, {
    name: 'eeat_questions',
  });
  const messages = buildAgentMessages(systemPrompt, input.messages, constraints);
  const q = (await model.invoke(messages)) as EeatQuestions;
  await ctx.emitLog('agent.questions.asked', q.progressNote, { count: q.questions.length });
  return {
    message: renderQuestionsMarkdown(q.questions),
    awaitingApproval: true,
    payload: {
      eeatPending: { questions: q.questions, askedAt: new Date().toISOString() },
    },
  };
}
```

`renderQuestionsMarkdown` produces a numbered list with hints in parens.

**Step 6: Stage 2 invoke** = the existing article path, but with the extended history (now containing the boss's answers). No major change beyond pulling `research` from `input.params.research` if present and prepending it to the system prompt.

**Step 7: Tests**

Update `tests/integration/shopify-blog-writer.test.ts` (or add a new one) to script:
1. First mock LLM call → `EeatQuestionsSchema` shape.
2. Assert task moves to `waiting` with `output.eeatPending`.
3. POST `/feedback` with answers.
4. Second mock LLM call → `ArticleSchema` shape.
5. Assert task moves to `waiting` with `output.pendingToolCall`.
6. Approve → publish tool fires.

**Step 8: Run, fix, commit**

```bash
pnpm test:all
git add src/agents src/orchestrator src/tasks tests/
git commit -m "feat(blog-writer): pre-draft EEAT Q&A waiting stage"
```

---

### Task 14: Writer loads packs (`seoFundamentals`, `eeat`, `aiSeo`, `geo`) into system prompt

**Files:**
- Modify: `src/agents/builtin/shopify-blog-writer/index.ts`

Mirror Task 11 pattern: extend `configSchema.skills` with all four toggles, `loadPacks` from this agent's local `packs/` dir, prepend to system prompt for both Stage 1 and Stage 2 invocations.

Default both `seoFundamentals` and `eeat` to `true`. `aiSeo` and `geo` default `false` until the markdown is supplied (or default `true` and ship empty placeholders — your call; I'd default `true` so as soon as you drop the file in, it activates).

**Tests:** assert pack content shows up in system prompt for both stages.

**Commit:**

```bash
git add src/agents/builtin/shopify-blog-writer tests/
git commit -m "feat(blog-writer): load SEO/EEAT/AI-SEO/GEO skill packs"
```

---

### Task 15: Strategist writes `research` block into spawnTasks input

**Files:**
- Modify: `src/agents/builtin/seo-strategist/index.ts`

In the `spawnTasks` builder, include the new fields:

```ts
const spawnTasks: SpawnTaskRequest[] = capped.map((t) => ({
  title: t.title,
  description: `SEO article — primary keyword: ${t.primaryKeyword}`,
  assignedAgent: t.assignedAgent,
  input: {
    brief: t.writerBrief,
    primaryKeyword: t.primaryKeyword,
    language: t.language,
    research: {
      searchIntent: t.searchIntent,
      paaQuestions: t.paaQuestions,
      relatedSearches: t.relatedSearches,
      competitorTopAngles: t.competitorTopAngles,
      competitorGaps: t.competitorGaps,
      targetWordCount: t.targetWordCount,
      eeatHook: t.eeatHook,
    },
  },
  ...(t.scheduledAt ? { scheduledAt: t.scheduledAt } : {}),
}));
```

**Tests:** the existing `tests/integration/spawning.test.ts` should already verify spawn — extend its assertion to include `task.input.research`.

**Commit:**

```bash
git add src/agents/builtin/seo-strategist tests/integration/spawning.test.ts
git commit -m "feat(seo-strategist): pass SERP research into Writer task input"
```

---

### Task 16: Writer reads `research` and surfaces it in both Stage 1 and Stage 2 prompts

**Files:**
- Modify: `src/agents/builtin/shopify-blog-writer/index.ts`

In each invoke, build a research block:

```ts
const research = (input.params as { research?: TopicResearch }).research;
const researchSection = research
  ? [
      'Research from the strategist:',
      `- Search intent: ${research.searchIntent}`,
      `- People Also Ask: ${research.paaQuestions.join(' / ')}`,
      `- Related searches: ${research.relatedSearches.join(' / ')}`,
      `- Competitor top angles: ${research.competitorTopAngles.join(' / ')}`,
      `- Competitor gaps: ${research.competitorGaps.join(' / ')}`,
      `- Target word count: ${research.targetWordCount}`,
      `- EEAT hook: ${research.eeatHook}`,
    ].join('\n')
  : '';
const systemWithResearch = researchSection
  ? `${systemPrompt}\n\n${researchSection}`
  : systemPrompt;
```

Pass `systemWithResearch` to `buildAgentMessages`.

Stage 1 must use `eeatHook` to focus its questions; the prompt instruction should make this explicit (append to `DEFAULT_PROMPT`).

**Tests:** scripted Writer test asserts both calls receive the research block in system prompt (snapshot or `expect(systemMessages).toContain(research.eeatHook)`).

**Commit:**

```bash
git add src/agents/builtin/shopify-blog-writer tests/
git commit -m "feat(blog-writer): consume strategist research in EEAT and draft prompts"
```

---

## Section E — End-to-end integration test

### Task 17: Full Strategist → Writer Q&A → draft → approve flow

**Files:**
- Create: `tests/integration/seo-cluster.test.ts`

Script the complete journey:

1. POST `/v1/intakes` → POST `/v1/intakes/:id/finalize` (or insert a strategy task directly via the existing helper).
2. Strategist task runs:
   - LLM script: tool-call AIMessage requesting `serper_search({query:'linen shirt'})`.
   - Serper fetch stub returns canned `{ organic: [...], peopleAlsoAsk: [...], relatedSearches: [...] }`.
   - LLM script: structured plan with 1 topic, complete `research` block.
3. Approve(finalize=true) → 1 child Writer task spawned.
4. Writer Stage 1: LLM script returns `EeatQuestionsSchema` with 2 questions; task → waiting.
5. POST `/feedback` with answers; task → todo.
6. Writer Stage 2: LLM script returns `ArticleSchema` with `progressNote` + `bodyHtml`; task → waiting with `pendingToolCall`.
7. Approve(finalize=true) → `shopify.publish_article` fired (Shopify HTTP stub returns success).
8. Assert task is `done`, `task.output.toolResult` populated, message thread contains: brief, EEAT questions, boss answers, draft, completion log.

Use existing helpers:
- `tests/integration/helpers/llm-mock.ts` — `scriptStructured` queue for LLM calls.
- Stub `globalThis.fetch` to return Serper responses for `google.serper.dev` and Shopify responses for `myshopify.com`.

**Run:**

```bash
pnpm test:integration -- tests/integration/seo-cluster.test.ts
```

**Commit:**

```bash
git add tests/integration/seo-cluster.test.ts
git commit -m "test(integration): end-to-end SEO cluster Strategist→Writer→publish"
```

---

## Section F — Final verification

### Task 18: Full suite + lint + typecheck

```bash
pnpm typecheck
pnpm lint
pnpm test:all
```

If anything fails, fix in place. Re-run until green.

**Commit any cleanup** (likely none if each task above stayed disciplined).

---

## Skills the executor should reference

- `@superpowers:test-driven-development` — Tasks 3, 4, 5, 6, 13, 14
- `@superpowers:systematic-debugging` — when integration test surfaces unexpected state
- `@superpowers:verification-before-completion` — at Task 18

## Risks the executor should watch for

- **Task 4 schema mismatch**: `onConflictDoUpdate` needs a unique constraint, not just an index. The plan flags this; if you forget, the cache will silently insert duplicates.
- **Task 10 two-pass model**: if the integration test's LLM mock doesn't handle `bindTools`, you'll need to extend `tests/integration/helpers/llm-mock.ts` with a `scriptToolCall(name, args)` helper that returns an AIMessage with `tool_calls`.
- **Task 13 stage detection**: the simplest signal is "last message role" — but if the worker is reclaimed mid-flight (stale lock), `history` could be partially seeded. Guard with: stage 1 only when `output.eeatPending` is unset; stage 2 when set AND last message is `user`. Crash if `eeatPending` is set AND last message is `assistant` (that means the worker double-executed; better to fail loud than ship a bad draft).
- **Task 16 research type**: define `TopicResearch` interface in `src/agents/builtin/seo-strategist/research.ts` and import from both the strategist and writer to avoid drift. The strategist's TopicSchema already enforces the shape; the type is just the inference.

## What NOT to do

- Do not enable per-tenant Serper keys in this iteration — schema, env, and tools are designed for v1 single platform key.
- Do not introduce pgvector or RAG for the packs — they are pure prompt fragments.
- Do not let the Writer make web calls — it consumes Strategist's research only.
- Do not invoke any non-`writing-plans` implementation skill from inside this plan; an executor follows it directly.
