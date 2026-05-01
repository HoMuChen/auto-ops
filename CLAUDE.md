# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Multi-tenant backend API for an AI e-commerce auto-operation platform. Pure Node.js/TypeScript service — no UI in this repo (a separate web frontend + Shopify Embedded App will consume it). Targets Shopify first; pluggable AI agents architecture for future expansion. Spec: `requirements.md`.

## Commands

```bash
pnpm dev                      # tsx watch — http://127.0.0.1:8080, /docs for Swagger
pnpm build                    # tsc -p tsconfig.build.json → dist/
pnpm typecheck                # tsc --noEmit
pnpm lint                     # biome check .
pnpm lint:fix                 # biome check --write .
pnpm test                     # unit tests only (no DB)
pnpm test:integration         # integration tests (requires local Supabase running)
pnpm test:all                 # both
pnpm db:generate              # drizzle-kit generate (after schema changes)
pnpm db:migrate               # tsx src/db/migrate.ts (idempotent, applies handwritten + generated)
pnpm db:studio                # drizzle-kit studio
```

Run a single test: `pnpm test -- tests/seo-strategist.test.ts` (or `pnpm test:integration -- tests/integration/lifecycle.test.ts`). Filter inside file with `-t "describe text"`.

Local Supabase: `supabase start` (CLI required). Studio at http://127.0.0.1:54323. Reset: `supabase db reset`. Connection string is in `.env` — see `.env.example`. After `supabase start`, always run `pnpm db:migrate` before integration tests.

## Architecture

### Three orthogonal layers

1. **HTTP layer** (`src/api/`) — Fastify 5 + `fastify-type-provider-zod` + `@fastify/swagger`. Every route declares Zod schemas → automatic validation + OpenAPI generation. Two preHandler hooks: `requireAuth` (verifies Supabase JWT via jose, JIT-upserts the `users` row) → `requireTenant` (checks `x-tenant-id` header against `tenant_members`). Route files are thin — they delegate to `src/tasks/repository.ts`, `src/agents/registry.ts`, etc.

2. **Task engine** (`src/tasks/`) — DB-as-queue. `tasks` table doubles as the kanban entity. State machine in `state-machine.ts` — every transition must go through `assertTransition`. The polling `TaskWorker` (`worker.ts`) calls `claimNextTask` (atomic `UPDATE … FOR UPDATE SKIP LOCKED RETURNING id`, then re-`SELECT` for camelCase mapping — see comment in `repository.ts`), then runs `runTaskThroughGraph`. The runner persists output, `pendingToolCall`, `spawnTasks` and stamps `assignedAgent`/`kind` so downstream paths don't need graph state.

3. **Orchestration layer** (`src/orchestrator/`) — LangGraph.js Supervisor/Router pattern. `buildGraph` constructs a per-tenant graph: START → supervisor → conditional edges to each tenant-enabled agent → back to supervisor → END. Postgres checkpointer persists `GraphState` keyed by `task.threadId`. `tool-executor.ts` is the **post-HITL** executor — when a user `/approve`s a task whose `output.pendingToolCall` is set, the executor builds the agent (only to read `tools[]`, not to call the LLM again), invokes the named tool, and stamps `output.toolResult` + `toolExecutedAt` (idempotent on retry).

### Pluggable agents (`src/agents/`)

`IAgent` contract: a `manifest` (id, name, model, plans, requiredCredentials, configSchema) + `build(ctx)` returning `{ tools, invoke }`. Registered at boot in `src/agents/index.ts:bootstrapAgents()`.

Three runtime mechanisms an agent can use:
- **Plain text completion** — `invoke()` returns `{ message, awaitingApproval: true, payload }`. On `/approve(finalize=true)` task just transitions to `done`.
- **`pendingToolCall`** — agent prepares a tool invocation but defers execution; framework fires it on approve. Used by `shopify-blog-writer` (publish_article) and `shopify-ops` (create_product).
- **`spawnTasks`** — strategy agents (kind: strategy) declare child execution tasks; framework spawns them atomically on approve via `finalizeStrategyTask` (idempotent via `output.spawnedAt`). Strategist picks `assignedAgent` per child from `ctx.availableExecutionAgents` (validated against the registry; tool-executor + repository both refuse unknown ids).

`task.kind` is **dynamic**: a task created as `execution` gets auto-promoted to `strategy` by the runner if the agent emitted `spawnTasks`. The metadata flag `manifest.metadata.kind = 'strategy'` is just a UI hint, not a contract.

The supervisor short-circuits its routing LLM call when `state.pinnedAgent` is set (execution children carry `task.assignedAgent` from the spawn) — saves a model call per child.

### LLM integration (`src/llm/`)

OpenRouter is the **only** gateway — single `OPENROUTER_API_KEY` replaces per-provider keys. `buildModel(modelConfig)` returns a `ChatOpenAI` instance with `baseURL: 'https://openrouter.ai/api/v1'`. Model selection is **fixed in code** per agent (in `manifest.defaultModel`); no per-tenant model override. Use `withStructuredOutput(zodSchema)` for any agent that produces machine-consumable fields.

### Multi-tenancy

Strategy B: app-layer `WHERE tenant_id = ?` filtering, with Postgres RLS as a future backstop. **RLS is currently disabled** — `drizzle/0001_rls_policies.sql.disabled` is renamed; re-enable when `withTenantContext` (in `src/db/tenant-context.ts`) is wired into every request. Until then, every repository function takes `tenantId` as the first parameter — never trust agent code to scope queries.

Tenant credentials live in `tenant_credentials` (currently **plaintext** — production blocker). `ShopifyAdminClient.forTenant(tenantId, label?)` resolves at tool-invocation time, not at agent build time, so credential changes take effect on the next approve.

## Conventions worth preserving

- **No backward-compat shims**: when refactoring an agent name or contract, rename across the codebase in one commit. Don't leave aliases.
- **Idempotent boundaries**: any operation that can be retried by a network client (approve, finalize-spawn, post-approval tool execution) checks for prior completion before acting. Mutations are stamped with `*At` timestamps.
- **Zod everywhere on the wire**: route I/O, agent config, structured LLM output. The Zod schema is the single source of truth — derive types via `z.infer`, render to JSON Schema for the activation form via `zod-to-json-schema`.
- **Tests are tiered**: unit tests mock the LLM (`tests/integration/helpers/llm-mock.ts` exposes `scriptStructured`/`scriptText` queues for the integration suite). Integration tests hit local Supabase but stub `fetch` for any external API (Shopify). No test should hit OpenRouter.
- **Drizzle returns Dates** — `src/api/schemas.ts` uses `z.preprocess(... .toISOString())` for any timestamp field on the response wire format. Don't bypass.

## What's NOT done yet (read before adding features)

- Cloudflare Images integration (regression: agents currently produce text-only)
- Credential encryption at rest
- pgvector / RAG knowledge base (Domain Experts)
- Subscription quota enforcement (per-tenant monthly task caps)
- Pagination on list endpoints
- Real OpenRouter smoke test (all current tests use the FakeChatModel mock)
- Webhook receivers for Shopify events
- Rate limiting

See `docs/API_GUIDE.md` for the consumer-facing API contract (UI team) and `requirements.md` for the original product spec.
