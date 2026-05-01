# auto-ops

Multi-tenant backend API for an AI e-commerce auto-operation platform. Pluggable AI agents that plan SEO content, draft articles, and manage Shopify products — all behind a human-in-the-loop (HITL) approval gate.

> **Status:** v0.1, pre-release. API shape may change; breaking changes are tagged `breaking:` in commit messages.
> **No UI in this repo** — a separate web frontend + Shopify Embedded App will consume this API. Contract for UI consumers: [`docs/API_GUIDE.md`](docs/API_GUIDE.md).

---

## What it does

You give the API a brief like _"plan a summer-women's-wear SEO campaign and publish it"_. An LLM **strategist** breaks it into focused topics; each topic becomes a child task that a **writer** agent drafts in multiple languages; you approve the draft; the framework publishes it to your Shopify blog. Same shape for product listings via the **shopify-ops** agent.

Everything is multi-tenant, audited via task logs, and resumable — the task queue is the database itself, so a crashed worker just resumes on restart.

### Built-in agents

| ID | What it does | External writes |
|---|---|---|
| `seo-strategist` | Turns a brief into N focused article topics, spawns a child task per topic | none (planning only) |
| `shopify-blog-writer` | Writes one multilingual SEO article from a focused brief | `shopify.publish_article` (after HITL approve) |
| `shopify-ops` | Drafts a Shopify product listing from a brief | `shopify.create_product` (after HITL approve) |

Every tenant sees every registered agent — there is no per-plan gating. The `tenants.plan` column is kept for future quota / billing hooks but no longer affects agent visibility.

Adding a new agent = implement `IAgent` (manifest + `build(ctx)`) and register it in `src/agents/index.ts:bootstrapAgents()`. Models are fixed per agent in code (via OpenRouter); no per-tenant model picker.

---

## Tech stack

- **Runtime:** Node ≥ 20.11, TypeScript, ESM
- **HTTP:** Fastify 5 + `fastify-type-provider-zod` + `@fastify/swagger` (OpenAPI auto-generated from Zod schemas)
- **DB:** Postgres (Supabase local in dev), Drizzle ORM, idempotent migration runner
- **Auth:** Supabase access tokens, verified via JWKS (ES256) — see [`src/auth/supabase-auth.ts`](src/auth/supabase-auth.ts)
- **Orchestration:** LangGraph.js Supervisor/Router, Postgres checkpointer
- **LLM gateway:** OpenRouter only (one API key, per-agent model slug)
- **Linter/formatter:** Biome
- **Tests:** Vitest (unit + integration; integration hits local Supabase, mocks LLM and external APIs)

---

## Architecture (one paragraph)

Three orthogonal layers: **HTTP** (`src/api/`) → thin Fastify routes that delegate to repositories. **Task engine** (`src/tasks/`) → DB-as-queue; the `tasks` table doubles as the kanban entity, claimed atomically with `FOR UPDATE SKIP LOCKED`; a state machine guards every transition. **Orchestration** (`src/orchestrator/`) → per-tenant LangGraph that routes between enabled agents, with a post-HITL `tool-executor` that fires deferred tool calls (publish article, create product) only after a user approves. Full deep-dive in [`CLAUDE.md`](CLAUDE.md).

```
UI / Shopify Embedded App
       │  Authorization: Bearer <Supabase JWT>
       │  x-tenant-id:   <UUID>
       ▼
┌──────────────────────────────────┐         ┌──────────────┐
│  Fastify (port 8080)             │ ───────▶│  OpenRouter  │
│  ─ requireAuth (JWKS verify)     │         └──────────────┘
│  ─ requireTenant                 │         ┌──────────────┐
│  ─ Routes / OpenAPI (Zod)        │ ───────▶│  Shopify     │
└──────────────────────────────────┘         │  Admin API   │
       │                                     └──────────────┘
       ▼
┌──────────────────────────────────┐
│  Postgres (Supabase)             │
│  ─ tasks (queue + kanban)        │
│  ─ task_logs / messages          │
│  ─ tenants / tenant_members      │
│  ─ agent_configs                 │
│  ─ tenant_credentials            │
│  ─ langgraph checkpoints         │
└──────────────────────────────────┘
       ▲
       │ poll + claim + run
┌──────────────────────────────────┐
│  TaskWorker (in-process)         │
│  → LangGraph supervisor          │
│  → agent invoke                  │
│  → HITL gate                     │
│  → tool-executor (post-approve)  │
└──────────────────────────────────┘
```

---

## Quickstart

```bash
# 1. Install
pnpm install

# 2. Local Supabase (Postgres + Auth)
supabase start                    # CLI required: brew install supabase/tap/supabase
                                  # Studio: http://127.0.0.1:54323

# 3. Env
cp .env.example .env
# Fill DATABASE_URL, SUPABASE_URL, OPENROUTER_API_KEY (mandatory)
# SUPABASE_ANON_KEY / SUPABASE_JWT_SECRET are now optional

# 4. Schema
pnpm db:migrate                   # idempotent — applies handwritten + generated SQL

# 5. Run
pnpm dev                          # http://127.0.0.1:8080
                                  # http://127.0.0.1:8080/docs (Swagger UI)
```

### Smoke test against the running API

```bash
# (a) create a user in Supabase Studio, then login:
PUBLISHABLE=$(supabase status -o env | grep ANON_KEY | cut -d= -f2- | tr -d '"')
TOKEN=$(curl -s -X POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
  -H "apikey: $PUBLISHABLE" -H 'Content-Type: application/json' \
  -d '{"email":"<email>","password":"<pwd>"}' \
  | jq -r .access_token)

# (b) create a tenant (caller becomes owner)
curl -s -X POST 'http://127.0.0.1:8080/v1/tenants' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Demo Shop","slug":"demo","plan":"basic"}'

# (c) verify membership
curl -s http://127.0.0.1:8080/v1/me -H "Authorization: Bearer $TOKEN"
```

---

## API surface

All paths under `/v1` except `/health` and `/docs`. Authoritative spec: `http://127.0.0.1:8080/docs/json` once the server is running.

| Method | Path | Auth | Tenant header | Notes |
|---|---|---|---|---|
| GET | `/health` | — | — | uptime check |
| GET | `/v1/me` | JWT | — | user + tenant memberships |
| POST | `/v1/tenants` | JWT | — | create tenant; caller becomes owner |
| GET | `/v1/agents` | JWT | ✓ | list agents + activation status |
| GET | `/v1/agents/:id` | JWT | ✓ | single agent detail |
| POST | `/v1/agents/:id/activate` | JWT | ✓ | validates plan + creds + config |
| POST | `/v1/agents/:id/deactivate` | JWT | ✓ | retains config |
| GET | `/v1/credentials` | JWT | ✓ | list bound providers (no secrets) |
| PUT | `/v1/credentials/:provider` | JWT | ✓ | upsert (e.g. `shopify`) |
| DELETE | `/v1/credentials/:id` | JWT | ✓ | |
| GET | `/v1/tasks` | JWT | ✓ | list (filter by `status`, `parentTaskId`) |
| POST | `/v1/tasks` | JWT | ✓ | dispatch a brief |
| GET | `/v1/tasks/:id` | JWT | ✓ | single task |
| GET | `/v1/tasks/:id/messages` | JWT | ✓ | conversation thread |
| GET | `/v1/tasks/:id/logs` | JWT | ✓ | audit log (filter by `since`) |
| GET | `/v1/tasks/:id/stream` | JWT | ✓ | SSE — live logs with replay |
| POST | `/v1/tasks/:id/approve` | JWT | ✓ | HITL gate; `finalize:true` fires deferred tool / spawns children |
| POST | `/v1/tasks/:id/feedback` | JWT | ✓ | reroute task with new instructions |
| POST | `/v1/tasks/:id/discard` | JWT | ✓ | mark failed |

UI integration patterns (SSE, pendingToolCall, task-spawning kanban) are documented in [`docs/API_GUIDE.md`](docs/API_GUIDE.md).

---

## Project layout

```
src/
  api/             Fastify routes + middleware (requireAuth, requireTenant)
  agents/          Pluggable agent registry + built-in agents
    builtin/
      seo-strategist/
      shopify-blog-writer/
      shopify-ops/
  auth/            Supabase JWT verifier (JWKS / ES256, HS256 fallback)
  config/          Env schema (Zod)
  db/              Drizzle schema + migration runner + tenant context (RLS, deferred)
  events/          Task event bus (drives SSE)
  integrations/    External API clients (e.g. ShopifyAdminClient)
  lib/             Errors and shared utilities
  llm/             OpenRouter model factory + structured output helpers
  orchestrator/    LangGraph build + supervisor + tool-executor
  tasks/           Repository, state machine, worker
  index.ts         Server bootstrap
  server.ts        Fastify app factory (used by tests too)

drizzle/           Generated + handwritten SQL migrations
docs/              API_GUIDE.md (UI consumer contract)
tests/             Unit tests (no DB)
tests/integration/ Hits local Supabase; mocks LLM + Shopify
```

---

## Commands

```bash
pnpm dev              # tsx watch — http://127.0.0.1:8080, /docs for Swagger
pnpm build            # tsc -p tsconfig.build.json → dist/
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm lint:fix         # biome check --write .
pnpm test             # unit tests only (no DB)
pnpm test:integration # integration tests (requires `supabase start` first)
pnpm test:smoke       # opt-in OpenRouter live smoke (gated by OPENROUTER_LIVE=1)
pnpm test:all         # unit + integration
pnpm db:generate      # drizzle-kit generate (after schema changes)
pnpm db:migrate       # apply handwritten + generated SQL (idempotent)
pnpm db:studio        # drizzle-kit studio
```

Single test:
```bash
pnpm test -- tests/seo-strategist.test.ts
pnpm test:integration -- tests/integration/spawning.test.ts -t "strategist plans"
```

---

## Testing strategy

- **Unit tests** (`tests/*.test.ts`) — pure logic, no DB, no network. LLM is replaced with `FakeChatModel` where needed.
- **Integration tests** (`tests/integration/*.test.ts`) — boot the real Fastify app against a local Supabase Postgres. LLM is scripted via `tests/integration/helpers/llm-mock.ts` (`scriptStructured` / `scriptText` queues). External APIs (Shopify) are stubbed at `fetch`. **`pnpm test` and `pnpm test:integration` never hit OpenRouter.**
- **Smoke tests** (`tests/smoke/*.test.ts`) — opt-in only. Gated by `OPENROUTER_LIVE=1` + a real `OPENROUTER_API_KEY`; otherwise the entire suite is skipped. Verifies that production model slugs in agent manifests still resolve and that `withStructuredOutput` returns parseable JSON on the real LLM. Costs real money — never run in default CI.
- The integration suite refuses to run against a non-local `DATABASE_URL` to prevent accidents.

---

## Configuration cheat sheet

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✓ | Postgres connection string |
| `SUPABASE_URL` | ✓ | Used to build the JWKS endpoint for token verification |
| `OPENROUTER_API_KEY` | ✓ | Single key for all LLM calls |
| `SUPABASE_ANON_KEY` | optional | Browser/UI key (CLI v2: `sb_publishable_…`) |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | Server-only Supabase admin key (CLI v2: `sb_secret_…`) |
| `SUPABASE_JWT_SECRET` | optional | Legacy HS256 fallback; required only for tests minting their own tokens |
| `WORKER_POLL_INTERVAL_MS` | default 2000 | Task worker poll cadence |
| `WORKER_MAX_CONCURRENCY` | default 4 | Concurrent task executions per worker |
| `OPENROUTER_REFERER` | default `https://auto-ops.local` | Attribution header |

Full list: [`.env.example`](.env.example) and [`src/config/env.ts`](src/config/env.ts).

---

## What's NOT done yet

- Cloudflare Images integration (agents currently produce text-only)
- Credential encryption at rest (currently plaintext — production blocker)
- pgvector / RAG knowledge base (Domain Experts)
- Subscription quota enforcement (per-tenant monthly task caps)
- Pagination on list endpoints
- Webhook receivers for Shopify events
- Rate limiting
- Postgres RLS re-enable (see [`drizzle/0001_rls_policies.sql.disabled`](drizzle/))

---

## Further reading

- [`CLAUDE.md`](CLAUDE.md) — architecture deep-dive for contributors
- [`docs/API_GUIDE.md`](docs/API_GUIDE.md) — UI consumer contract (Chinese)
- [`requirements.md`](requirements.md) — original product spec
- Live OpenAPI: `http://127.0.0.1:8080/docs/json` after `pnpm dev`
