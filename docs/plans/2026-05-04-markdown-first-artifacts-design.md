# Markdown-First Artifacts Design

**Status:** Approved (brainstorming) — implementation plan to follow
**Date:** 2026-05-04
**Scope:** Refactor agent output / inter-agent handoff to be markdown-primary instead of typed JSON.

---

## Goal

Stop modeling each agent's output as a bespoke typed JSON shape. Make the canonical agent output a markdown narrative (`report`) plus, where applicable, a markdown deliverable (`body`) and a small structured contract (`refs`) for things that genuinely need machine reading. Inter-agent handoff becomes prose, not schema.

The result: **adding a new agent does not require any new artifact type, schema, or frontend component.** It just needs to write good markdown.

---

## Background — what we have today

Each agent emits a typed `artifact` (discriminated union on `kind`). Six kinds today:

| kind | producer | data fields |
|---|---|---|
| `clarification` | supervisor | `question` |
| `seo-plan` | seo-strategist | `summary` (markdown), `topics[]` |
| `product-plan` | product-planner | `summary`, `variants[]` |
| `eeat-questions` | shopify-blog-writer (stage 1) | `summary`, `questions[]`, `askedAt` |
| `blog-article` | shopify-blog-writer (stage 2) | `title`, `bodyHtml`, `summaryHtml`, `summary`, `tags`, `language`, `author?` |
| `product-content` | product-designer + shopify-publisher | `title`, `bodyHtml`, `summary`, `tags`, `vendor`, `productType?`, `language`, `imageUrls` |

Inter-agent handoff (e.g., `seo-strategist → shopify-blog-writer`) is structured: child task `input` carries `{ brief, primaryKeyword, language, research: { paaQuestions, relatedSearches, … } }`.

`summary` was added recently as a band-aid — a markdown blob alongside the JSON so humans have something readable.

---

## Problems with the current design

1. **Schema sprawl** — every new agent ⇒ new artifact kind ⇒ new Zod schema in `src/api/schemas.ts` ⇒ new TS interface in `src/tasks/artifact.ts` ⇒ new frontend renderer. Onboarding cost grows linearly.
2. **Two source of truth per artifact** — `summary` (markdown for humans) and `data.*` (structured for machine). They drift; agents have to maintain consistency.
3. **Inter-agent context loss** — strategist's reasoning ("considered X but rejected because Y") doesn't survive structured handoff; downstream agents lose nuance.
4. **LLM input format mismatch** — downstream agents read structured JSON in prompt, then mentally re-flatten field paths. LLMs read prose more naturally.
5. **Frontend complexity** — separate component per artifact kind; can't display arbitrary new agents without code changes.

---

## Approach — option A' (`report` + `body?` + `refs?`)

Replace the discriminated `artifact` union with a uniform shape:

```ts
interface Artifact {
  /** Canonical narrative — what the agent did, why, what it found, what it concluded.
   *  This is the primary surface humans AND downstream agents read.
   *  Everything that doesn't have a hard machine-reading requirement lives here. */
  report: string;            // markdown, no length cap

  /** Optional deliverable — the actual content the agent produced for end consumers.
   *  Only present for agents that produce publishable content (article, product listing).
   *  Markdown — converted to HTML at the publish boundary if needed. */
  body?: string;             // markdown

  /** Optional structured contract — only fields that genuinely need machine reading:
   *  IDs, URLs, scheduling, routing. No narrative content here. */
  refs?: Record<string, unknown>;
}
```

**Rules of thumb for what goes where:**

| Goes in `report` | Goes in `refs` |
|---|---|
| Research findings, competitor analysis | IDs (articleId, blogId, productId) |
| Decision rationale, trade-offs considered | URLs (imageUrls, articleUrl) |
| Tone / angle / E-E-A-T hooks | Scheduling (`scheduledAt`) |
| Soft targets ("around 1500 words") | Hard counts that affect publishing logic |
| Quotes from research | Booleans (autoPublish, draft/active) |
| Anything LLMs read better as prose | Anything tools / spawn / publish need exact |

**`body` only exists when there's an actual deliverable to publish.** Strategy agents (seo-plan, product-plan) and clarifying agents (eeat-questions, clarification) only have `report`. Content agents (blog-article, product-content) have both `report` (decisions) and `body` (the article / description).

---

## Why A' beats the alternatives

We considered three options during brainstorming:

- **A (pure markdown, single field)** — agent emits one big markdown report, body extracted by heading convention at publish time. Rejected: implicit contract via heading parsing is brittle and breaks when prompts evolve.
- **B (markdown report + structured `bodyHtml`)** — narrative + HTML body in refs. Rejected: HTML in refs is awkward to display alongside narrative; markdown body is cleaner and converts at the boundary.
- **C (keep typed artifacts, add long markdown narrative)** — additive, no break. Rejected: doesn't solve schema sprawl — still adds a new type per agent.

**A' wins** because:
- One markdown renderer covers all narrative + body (frontend gets a single primitive).
- `refs` is a free-form bag — adding/removing keys doesn't touch shared schemas.
- Markdown→HTML conversion is a single, well-bounded concern at publish time.
- New agent contributors only think about prompts, not types.

---

## Per-agent mapping

### supervisor (clarification)

Currently: `artifact: { kind: 'clarification', data: { question } }` + `awaitingApproval: true`.

A':
```ts
{
  report: `## 我需要再確認一下\n\n${question}\n\n請補充更多資訊我才能往下做。`,
  // no body, no refs
}
```

The clarification *is* the report — there's nothing else.

### seo-strategist (SEO plan)

Currently: `data.summary` (markdown) + `data.topics[]` (typed).

A':
```ts
{
  report: `# SEO 策略規劃\n\n## TL;DR\n…\n\n## 市場觀察\n…\n\n## 規劃選題\n\n### 主題 1：…\n- 主關鍵字：…\n- 切角：…\n- 競品缺口：…\n- E-E-A-T hook：…\n\n### 主題 2：…\n…`,
  refs: {
    spawnAssignedAgent: 'shopify-blog-writer',  // routing only
  },
}
```

`spawnTasks` (the actual child task list) stays on `task.output.spawnTasks` outside the artifact — see Flow Control section.

The child task's `input` gets:
```ts
{
  brief: string,    // the relevant portion of strategist's report — that topic's section
  refs: {           // tiny — only what's hard to read from prose
    primaryKeyword: string,
    language: string,
  },
}
```

Writer agent reads the markdown brief, uses the prose to write the article. `refs.primaryKeyword` is duplicated in the brief but kept structured because it must not drift.

### product-planner (product plan)

Same shape as seo-strategist:
- `report` = full markdown plan with each variant as a section.
- `refs.spawnAssignedAgent: 'product-designer'`.
- Child input: `{ brief: <variant section as markdown>, refs: { language, originalImageIds } }`.

### shopify-blog-writer — stage 1 (E-E-A-T questions)

Currently: `data: { summary, questions[], askedAt }` + `eeatPending` flow control.

A':
```ts
{
  report: `## 我需要先請你回答幾個問題\n\n為什麼要問：…\n\n1. **${q1.question}** — ${q1.hint}\n2. **${q2.question}**\n3. **${q3.question}** *(選填)*\n\n答完之後我會把這些經驗融進文章裡。`,
  refs: {
    askedAt: string,  // ISO timestamp — resume logic depends on this
  },
}
```

Questions are listed in the report as an ordered list; user reads and answers in feedback. `eeatPending` flow flag stays on `task.output` (see Flow Control).

### shopify-blog-writer — stage 2 (article)

Currently: `data: { title, bodyHtml, summaryHtml, summary, tags, language, author? }` + `pendingToolCall(shopify.publish_article)` flow control.

A':
```ts
{
  report: `# 文章寫好了：${title}\n\n## 我的切入角度\n…\n\n## 為什麼選這個標題\n…\n\n## 這篇文章的 E-E-A-T 強化\n…`,
  body: `# ${title}\n\n${article body in markdown — no HTML}…`,
  refs: {
    title: string,           // for tool call
    summaryHtml: string,     // Shopify excerpt — separate field, short
    tags: string[],
    language: string,
    author?: string,
  },
}
```

`pendingToolCall` flow flag stays on `task.output`. Its args are built from `body` (converted to HTML via `markdownToHtml(body)`) + `refs` fields. See Tool Args section.

### product-designer (product content)

Currently: `data: { title, bodyHtml, summary, tags, vendor, productType?, language, imageUrls }`.

A':
```ts
{
  report: `# 商品設計完成：${title}\n\n## 文案切角\n…\n\n## 我畫了哪些圖\n\n![主視覺](url1)\n\n這張強調…\n\n![情境圖](url2)\n\n用在客廳場景…`,
  body: `${product description in markdown}`,
  refs: {
    title: string,
    tags: string[],
    vendor: string,
    productType?: string,
    language: string,
    imageUrls: string[],
  },
}
```

Note: images appear inline in `report` via markdown `![alt](url)` syntax (frontend renders naturally) AND as a flat list in `refs.imageUrls` (for shopify-publisher to attach to product). Same URLs, two access paths — no duplication of content, just two references.

`spawnTasks` to publishers stays on `task.output`. Each publisher child receives this artifact (whole) as its input — no re-parsing needed; publisher reads from `refs` and `body`.

### shopify-publisher (forwarded product content)

Currently: builds `pendingToolCall(shopify.create_product)` and emits the same `product-content` artifact.

A':
- Reads `task.input.params.artifact` (the artifact passed from product-designer).
- Emits `report` summarizing "我準備發佈這份商品內容". May include the inherited `body` and images for context.
- `body` is forwarded.
- `refs` is forwarded with maybe `+ { ready: true }`.
- `pendingToolCall(shopify.create_product)` flow flag set; args built from `refs` + converted body HTML.

After publish, `tool-executor` stamps `refs.published = { productId, handle, adminUrl, status }`.

---

## Flow control — unchanged shape, lives outside artifact

These stay on `task.output` next to (not inside) `artifact`:

```ts
interface TaskOutput {
  artifact?: Artifact;                  // new shape: { report, body?, refs? }
  pendingToolCall?: { id: string; args: Record<string, unknown> };
  spawnTasks?: SpawnTaskRequest[];
  spawnedAt?: string;
  spawnedTaskIds?: string[];
  toolExecutedAt?: string;
  eeatPending?: { questions: EeatQuestion[]; askedAt: string };
  generatedImageIds?: string[];
}
```

**Why outside `artifact`:** flow control is a task-engine concern (state machine, idempotency, gating). Artifact is a deliverable concern. Mixing them means the artifact can't be "just the deliverable". Keeping flow flags on `output` directly preserves the existing state machine, idempotency stamps, and approval routing without change.

`pendingToolCall.args` and `eeatPending.questions[]` remain structured because the *tool executor* and *resume logic* read them programmatically. They're not narrative.

---

## Tool args derivation

Some agents end with `pendingToolCall` (publish_article, create_product). The tool args must be structured (Shopify Admin API takes JSON, not markdown).

**Rule: agents build tool args at output time** — at the moment the artifact is emitted, the agent code (in TS, not the LLM) constructs `pendingToolCall.args` from `body` + `refs`:

```ts
const bodyHtml = markdownToHtml(artifact.body);  // marked, single conversion
const pendingToolCall = {
  id: 'shopify.publish_article',
  args: {
    title: artifact.refs.title,
    bodyHtml,
    summaryHtml: artifact.refs.summaryHtml,
    tags: artifact.refs.tags,
    blogHandle: cfg.shopify.blogHandle,
    publish: cfg.shopify.autoPublish,
  },
};
```

This means:
- Markdown→HTML conversion happens once, at agent output time, deterministically.
- Tool executor reads `args` directly — no derivation, no re-parsing of markdown later.
- `args.bodyHtml` is a derivative of `body` (markdown is canonical), but it's not "duplicated content" in any meaningful sense — it's a format conversion bound for an external API.

**markdown→HTML conversion lives in `src/agents/lib/markdown.ts`** as a thin wrapper around `marked`. Sanitization (DOMPurify or similar) runs at the same call site since publishing arbitrary HTML to Shopify is risky.

---

## Trade-offs we are accepting

These are real costs of going markdown-first; we choose them deliberately:

1. **Numeric drift in handoff.** `report` saying "目標約 1500 字" may be interpreted as 1200 by the writer LLM. Mitigation: when a number truly must be precise (and the downstream LLM doesn't reliably hit it from prose), put it in `refs` and let the agent code interpolate `{{refs.targetWordCount}}` into the writer's prompt template.
2. **Validation moves later in the pipeline.** With a typed schema, missing/wrong fields are caught at spawn time (Zod parse). With markdown briefs, the writer agent might run partially before discovering the brief is incoherent. Mitigation: cheap pre-flight checks on `report.length` and `refs` keys at spawn time. Quality of brief is monitored via logs, not enforced as schema.
3. **Programmatic introspection becomes harder.** Asking "how many topics did this strategist plan?" used to be `output.artifact.data.topics.length`. Now it's "count `### ` headings in `report`" or "len(spawnTasks)". For analytics, prefer the latter (`spawnTasks` is structured) or add a counter to `refs` if needed.
4. **TypeScript loses field-level safety.** `report: string` carries no shape info. Refactoring (find-all-usages of `paaQuestions`) won't track through prose. Mitigation: agent unit tests assert that prompts produce reports containing key sections; logs preserve structured tool-call records for grep.
5. **Token cost in long pipelines.** Each agent's report potentially feeds into the next. Markdown is more verbose than JSON. Mitigation: pass only the relevant *section* of strategist report into each writer child, not the whole thing. Strategist's spawn logic slices by topic.
6. **Prompt injection surface widens.** User feedback / strategist output passed verbatim into downstream prompts. Today this risk exists for `brief` (already prose); A' just adds more prose to it. Mitigation: prompt templates clearly delimit user/strategist content (e.g., XML-tagged blocks); no new mitigation needed beyond what's already done.

---

## Migration strategy

Clean break, single PR. No backward compat, no shim period.

**Why clean break:** consistent with the project's "no backward-compat shims" convention (CLAUDE.md). The artifact shape isn't persisted long-term in a way that needs migration — old `task.output` rows in the DB stay valid as JSON blobs but won't be re-rendered correctly by the updated frontend. Acceptable: completed-task history is read-only and the few in-flight tasks at deploy time can be re-run.

**Order of changes:**
1. Define new `Artifact` interface in `src/tasks/artifact.ts`. Replace the discriminated union.
2. Update `ArtifactSchema` in `src/api/schemas.ts` — three optional fields, all loose.
3. Update each agent in turn (supervisor → strategists → blog-writer → designer → publisher), adjusting both output shape and any input-reading logic in spawned children.
4. Update `tool-executor.ts` to stamp `refs.published` instead of artifact-kind-specific shapes.
5. Update `runner.ts` and `graph.ts` if they touch the old artifact fields.
6. Add `src/agents/lib/markdown.ts` for markdown→HTML conversion (uses `marked` + `dompurify`).
7. Update integration + unit tests to assert the new shape.
8. Update `docs/API_GUIDE.md` and Swagger.

`requirements.md` doesn't require update — it's product-level.

---

## Testing strategy

**Unit tests:**
- Each agent's structured-output schema test: assert it includes `report` (length > N), and conditionally `body` / `refs` shape.
- Markdown→HTML conversion: round-trip a few representative inputs.
- Tool args builders: given a fake artifact, assert the resulting `pendingToolCall.args`.

**Integration tests:**
- Lifecycle test (existing): assert end-to-end that strategist's `report` reaches writer's input as a markdown brief, writer produces `body` markdown, publisher's tool args include converted HTML.
- E-E-A-T flow: stage-1 artifact has `report` listing questions; after feedback, stage-2 produces `body` article.
- Spawning: each spawned child task's `input.brief` is a non-empty markdown string sourced from the parent's `report`.

**No assertions against prose content of `report`** — that's LLM output and tests would be flaky. Assert structural properties (length, presence of `body`, key fields in `refs`) only. Prose quality is monitored via the `summary`-style logs, not asserted in CI.

---

## Non-goals

- **Frontend redesign.** This design is backend-only. Frontend will eventually want a single markdown renderer + small refs panel, but that's a follow-up tracked separately.
- **Replacing structured `pendingToolCall.args`.** Tool args stay typed for safety at the external boundary.
- **Replacing `spawnTasks` typed schema.** Spawn requests still carry `assignedAgent`, `title`, `scheduledAt` as typed fields — that's task-engine contract, not artifact contract.
- **Markdown→HTML at frontend.** Conversion happens server-side at publish boundary so Shopify always receives sanitized HTML; frontend renders the markdown directly via React Markdown.
- **Schema-less LLM output.** Agents still use `withStructuredOutput` to produce `{ report, body?, refs? }` reliably. The structure of *the artifact wrapper* is fixed — the *contents of report/body* are free-form prose.

---

## Open follow-ups (out of scope here)

- Frontend re-render: replace per-kind components with single `<ArtifactView>` (markdown + refs panel + tool-call status).
- Token budget telemetry: log per-agent input token counts to monitor pipeline growth.
- Optional: a `refs.tldr` short-form for list-view cards if frontend finds slicing `report` insufficient.
