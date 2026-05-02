# SEO Agents Upgrade — Design

**Status:** Approved (brainstorm 2026-05-02)
**Scope:** Upgrade `seo-strategist` and `shopify-blog-writer` to do real SERP-driven keyword research and EEAT-aware drafting.

## Goal

Lift article quality from "AI-generic" to "ranking-competitive + experience-grounded" by giving:
- **Strategist** real SERP data (top 10, PAA, related searches) so each topic has a defended search intent and differentiation angle.
- **Writer** EEAT discipline (asks the boss for personal experience BEFORE drafting) plus baked-in SEO best practices delivered as swappable markdown skill packs.

## Non-Goals (v1)

- pgvector / RAG. Skill content is prompt-fragment markdown, not retrieved chunks.
- Per-tenant Serper key. v1 uses one platform-wide `SERPER_API_KEY`.
- Writer-side web search / fact-checking. Writer only consumes Strategist's research + boss's EEAT answers.
- Cross-locale SERP cache sharing. Cache key is `(tenantId, query, locale)`.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| EEAT capture flow | **Pre-draft Q&A** (writer asks → boss answers → writer drafts) | Matches "員工先問清楚" metaphor; reuses existing `waiting` state machine; cleaner draft quality than mid-draft gap markers. |
| Web search provider | **Serper.dev** | Returns Google SERP structure (PAA / related / organic ranks) — the only SEO-relevant data. Tavily/Brave optimised for content RAG, not SEO research. |
| Research data flow | **Mid-tier structured `research` block** on each topic | Writer needs structured PAA / `eeatHook` to drive Q&A focus and H2 outline. Markdown-in-brief loses analytics surface; full `keyword_research` table is YAGNI. |
| Skill loading | **Prompt fragments — markdown packs in repo** | User workflow is "我寫 markdown → 你接" — direct mapping. SEO/EEAT/GEO are universal rules, not chunk-retrieval problems. Iteration speed beats RAG sophistication. |
| Serper API key | **Platform-wide env (`SERPER_API_KEY`)** | Simplifies onboarding; absorbed by the platform; per-tenant BYO can layer on later via existing `tenant_credentials`. |

## Architecture

### Lifecycle (with new HITL)

```
INTAKE
  └─ approve → Strategist task (kind=strategy)
        ├─ Strategist runs Serper N times (cached) → produces Plan with research per topic
        └─ approve(finalize=true) → spawnTasks N children (Writer execution tasks)
              ├─ Writer task #1
              │     ├─ 1st invoke: read brief+research → emit eeatQuestions → waiting
              │     ├─ /feedback (boss answers) → todo → claimed
              │     ├─ 2nd invoke: read brief+research+Q&A → draft article → waiting
              │     └─ approve(finalize=true) → publish via shopify.publish_article
              ├─ Writer task #2 ...
              └─ Writer task #3 ...
```

### Component additions

#### Serper integration
- `src/integrations/serper/client.ts` — thin fetch wrapper, env key only
- `src/integrations/serper/tools.ts` — exports `serper.search` LangChain tool
- Tool input: `{ query: string, locale?: string, num?: 10 }`
- Tool output (typed): `{ organic: { title, url, snippet, position }[], peopleAlsoAsk: string[], relatedSearches: string[], knowledgeGraph?, answerBox? }`
- Tool internally consults the cache before hitting Serper; on miss, fetches + writes back

#### SERP cache
- New table `serp_cache(tenant_id, query_hash, locale, payload jsonb, expires_at, fetched_at)`
- Primary key: `(tenant_id, query_hash, locale)`
- TTL: 7 days (configurable via env)
- `query_hash`: sha256 of normalized query (lowercase, trimmed)
- Index `serp_cache_expires_idx` on `expires_at` for cheap pruning

#### Skills pack system
- Layout: `src/agents/builtin/<agent>/packs/*.md`
- Frontmatter: `--- name: AI SEO Practices\nversion: 1\n---`
- New `src/agents/lib/packs.ts` exports:
  - `loadPacks(agentDir, enabled: Record<string, boolean>): Promise<string>`
  - Reads `packs/*.md`, parses frontmatter, includes only those whose key is `true`, joins with `\n\n## Skill: <name> (v<version>)\n\n<body>` separators
- Strategist `cfg.skills`: `{ seoFundamentals, aiSeo, geo }`
- Writer `cfg.skills`: `{ seoFundamentals, eeat, aiSeo, geo }`
- Each defaults `true`; tenants can disable for token cost control
- v1 ships starter content for `seo-fundamentals.md` (Strategist + Writer) and `eeat.md` (Writer-only). User supplies `ai-seo.md` and `geo.md` later — drop in `packs/`, no code change

#### Strategist plan schema (TopicSchema additions)
```ts
{
  // existing
  title, primaryKeyword, language, writerBrief, assignedAgent, scheduledAt,
  // NEW
  searchIntent: z.enum(['informational', 'commercial', 'transactional', 'navigational']),
  paaQuestions: z.array(z.string()).max(8),       // → Writer's H2 candidates
  relatedSearches: z.array(z.string()).max(10),   // → long-tail weaving
  competitorTopAngles: z.array(z.string()).max(5),
  competitorGaps: z.array(z.string()).max(5),     // → differentiation
  targetWordCount: z.number().int().min(400).max(4000),
  eeatHook: z.string().min(20).max(300),          // → drives Writer's Q&A focus
}
```

These flow as part of `topic.input` into the Writer's spawned task.

#### Writer two-stage flow
- New Zod schema `EeatQuestionsSchema`:
  ```ts
  {
    questions: z.array(z.object({
      question: string,
      hint?: string,
      optional?: boolean,
    })).min(1).max(5),
    progressNote: string,
  }
  ```
- Writer's `invoke()` decides which stage by inspecting `task.output.eeatPending` + presence of follow-up user messages:
  - **Stage 1** (no `eeatPending`): produce questions, return `{ awaitingApproval: true, payload: { eeatPending: { questions, askedAt } } }`. Persisted into `task.output.eeatPending`.
  - **Stage 2** (`eeatPending` exists AND new user message after `askedAt`): produce article draft (existing `ArticleSchema`) using brief + research + Q&A turns. Returns `{ awaitingApproval, pendingToolCall: shopify.publish_article }` as today.
- Pure function of `task.output` + `messages` — restart-safe.

#### TaskOutput type additions
Extend `src/tasks/output.ts`:
```ts
export interface TaskOutput {
  // existing: spawnTasks/spawnedAt/spawnedTaskIds, pendingToolCall/toolResult/toolExecutedAt
  eeatPending?: {
    questions: { question: string; hint?: string; optional?: boolean }[];
    askedAt: string;
  };
  // (eeatAnswers is implicit in the message thread; no need to denormalise)
  [key: string]: unknown;
}
```

#### Approve/feedback semantics
- No new HTTP routes. Writer's first `waiting` is just a normal HITL gate; boss `/feedback` with answers; second `waiting` is the existing draft gate; `/approve(finalize=true)` triggers the existing pendingToolCall path.
- The route `tasks/:id/approve` does not need to learn about EEAT — the Writer's stage-detection handles it.

## Data flow detail (Writer stage 1 → 2)

1. Spawn: `task.input = { brief, primaryKeyword, language, research: { searchIntent, paaQuestions, ... }, eeatHook }`
2. Worker claims → graph builds Writer with `cfg.skills` packs concatenated into system prompt
3. Stage 1 invoke: Writer reads `task.input` (no `output.eeatPending` yet, no follow-up message) → emits `EeatQuestions` → runner persists into `output.eeatPending` → status `waiting`
4. UI renders questions; boss replies via `/feedback` → message appended → status `todo`
5. Worker claims → Stage 2 invoke: Writer sees `output.eeatPending` is set AND a new user message exists after `askedAt` → produces `Article` → runner persists payload + `pendingToolCall` → status `waiting`
6. Boss `/approve(finalize=true)` → existing tool-executor publishes article to Shopify

## Caching semantics

- Strategist's typical run: 5–15 Serper calls per plan (one per seed-cluster query).
- Within a plan, identical normalized queries hit cache (e.g. `"linen shirts summer"` searched twice across topic angles).
- Across plans within 7 days for the same tenant, cluster keywords likely overlap — cache reduces cost.
- Cache TTL is conservative (7d) because SERP shifts daily; if a customer needs fresh data they can rerun at TTL boundaries.

## Schema / DB changes

- New migration: `drizzle/<n>_serp_cache.sql` — creates `serp_cache` table + indexes.
- No schema change for `agent_configs` (`config` is already jsonb).
- No schema change for `tasks.output` (`output` is already jsonb; `TaskOutput` type narrows in TypeScript only).

## Testing strategy

### Unit
- `serper/client.test.ts`: mock fetch, assert URL/headers/body, parse Serper's response shape into our typed shape.
- `serper/cache.test.ts`: hit/miss, TTL expiry, query hash normalization (case/whitespace).
- `agents/lib/packs.test.ts`: frontmatter parse, enabled/disabled filtering, deterministic ordering.
- `seo-strategist.test.ts`: extend existing — assert structured output includes new research fields; assert `serper.search` calls deduplicated via cache stub.
- `shopify-blog-writer.test.ts`: extend existing — Stage 1 returns questions, Stage 2 returns article. Mock LLM in scripted mode.

### Integration
- New `tests/integration/seo-cluster.test.ts`: Strategist plan with research → spawn 2 writers → first writer goes through full Q&A waiting → feedback → draft waiting → approve → simulated `shopify.publish_article` call. All using LLM scripted mock + Serper fetch stub. No real network.

### Out of scope
- Real Serper smoke test (cost; covered by manual smoke before release).
- Real OpenRouter call (already excluded per CLAUDE.md).

## Risks / mitigations

- **LLM forgets to populate research fields.** Mitigation: Zod `.min(...)` constraints; Strategist already retries on structured-output validation failure (LangChain default).
- **Pack token bloat.** Mitigation: per-pack toggle; default-on but the activation UI surfaces estimated tokens per pack so power users can trim.
- **Writer Stage 2 fires before boss answers (race).** Mitigation: Stage detection requires a user message timestamped after `eeatPending.askedAt`. Worker idle when no new message exists.
- **Cache stale during a brand voice pivot.** Mitigation: 7-day TTL; manual invalidation tool can be added later if needed.

## Open follow-ups (post-merge, not gating)

- Per-tenant Serper BYO key (drop into existing `tenant_credentials.serper`).
- Pack version surfaced in task log so we know which version produced which article.
- Cache pruning cron (after pgvector lands or sooner, whichever first).
- Strategist re-research when boss `/feedback`s the plan (currently re-invokes from scratch — fine for v1).
