# Markdown-First Artifacts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the typed discriminated-union `Artifact` with a uniform `{ report: string; body?: string; refs?: Record<string, unknown> }` shape, and migrate every agent + every consumer to it. Following design doc `docs/plans/2026-05-04-markdown-first-artifacts-design.md`.

**Architecture:** Two-step type migration. Task 2 introduces the new `Artifact` interface alongside a renamed `LegacyArtifact` so the codebase keeps compiling while agents migrate one at a time (Tasks 3–8). Tool-executor switches to dispatching on `refs.published` (Task 9). Task 10 deletes `LegacyArtifact` and tightens schemas. Markdown→HTML conversion is a single helper (`src/agents/lib/markdown.ts`) used at the publish boundary only.

**Tech Stack:** TypeScript, Zod, LangChain, Vitest. New runtime dep: `marked` (HTML conversion). No new infra.

---

## Pre-flight

Read the design doc first: `docs/plans/2026-05-04-markdown-first-artifacts-design.md`. Pay attention to **Per-agent mapping** — that section dictates the exact `report`/`body`/`refs` split for each agent. Refer back to it for every agent task.

Run baseline:

```bash
pnpm typecheck && pnpm test
```

Expected: clean. If anything is red, stop and fix before starting.

---

### Task 1: Add markdown→HTML helper

**Files:**
- Create: `src/agents/lib/markdown.ts`
- Create: `tests/agents-lib-markdown.test.ts`
- Modify: `package.json` (add `marked` dep)

**Step 1: Add the dependency**

```bash
pnpm add marked
```

Verify it landed:

```bash
grep '"marked"' package.json
```

Expected: a line like `"marked": "^14.0.0"` (or whatever's current).

**Step 2: Write the failing test**

Create `tests/agents-lib-markdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../src/agents/lib/markdown.js';

describe('markdownToHtml', () => {
  it('converts headings', () => {
    expect(markdownToHtml('# Hello')).toContain('<h1>Hello</h1>');
  });

  it('converts unordered lists', () => {
    const html = markdownToHtml('- a\n- b');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>b</li>');
  });

  it('converts paragraphs', () => {
    expect(markdownToHtml('hello\n\nworld')).toContain('<p>hello</p>');
  });

  it('preserves inline links', () => {
    expect(markdownToHtml('[x](https://e.com)')).toContain('<a href="https://e.com">x</a>');
  });

  it('preserves images', () => {
    expect(markdownToHtml('![alt](https://e.com/a.png)')).toContain(
      '<img src="https://e.com/a.png" alt="alt"',
    );
  });

  it('returns empty string for empty input', () => {
    expect(markdownToHtml('')).toBe('');
  });

  it('handles fenced code blocks', () => {
    const html = markdownToHtml('```\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code>');
  });
});
```

**Step 3: Run the test, expect it to fail**

```bash
pnpm test -- tests/agents-lib-markdown.test.ts
```

Expected: failure with module-not-found on `src/agents/lib/markdown.ts`.

**Step 4: Implement**

Create `src/agents/lib/markdown.ts`:

```ts
import { marked } from 'marked';

/**
 * Convert agent-emitted markdown body into HTML for downstream consumers
 * (Shopify Admin API, etc). One conversion at the publish boundary; agents
 * never touch HTML directly.
 *
 * Async-renderer support is disabled (`async: false`) so callers can stay
 * synchronous. GFM is on for tables and task lists.
 */
marked.setOptions({ async: false, gfm: true, breaks: false });

export function markdownToHtml(md: string): string {
  if (!md) return '';
  return marked.parse(md) as string;
}
```

**Step 5: Run the test, expect it to pass**

```bash
pnpm test -- tests/agents-lib-markdown.test.ts
```

Expected: 7 passing.

**Step 6: Commit**

```bash
git add src/agents/lib/markdown.ts tests/agents-lib-markdown.test.ts package.json pnpm-lock.yaml
git commit -m "feat(markdown): add markdownToHtml helper for publish boundary

$(printf 'One-place conversion using marked. Agents emit markdown body;\nthis helper renders to HTML at the publish step (Shopify Admin\nAPI). GFM enabled for tables, async disabled for sync callers.\n')"
```

---

### Task 2: Introduce new Artifact type alongside legacy

We rename the current discriminated union to `LegacyArtifact` and add the new flat shape as `Artifact`. Both are accepted in `TaskOutput.artifact` and `ArtifactSchema` during migration. Once every agent migrates (Tasks 3–8), Task 10 removes the legacy form.

**Files:**
- Modify: `src/tasks/artifact.ts`
- Modify: `src/api/schemas.ts`
- Modify: `src/tasks/output.ts`

**Step 1: Replace `src/tasks/artifact.ts`**

Replace its entire content with:

```ts
/**
 * Task artifacts — the typed deliverables produced by agents.
 *
 * We're migrating from a discriminated union (`LegacyArtifact`, kept here
 * during the refactor) to a flat shape (`Artifact`):
 *
 *   {
 *     report: string,             // markdown narrative — primary surface
 *     body?: string,              // markdown deliverable — only for content agents
 *     refs?: Record<string, unknown>,  // structured contract for IDs/URLs/scheduling
 *   }
 *
 * Inter-agent handoff is markdown; structured fields exist only where they
 * absolutely must (machine reading by tools, spawn routing, idempotency stamps).
 *
 * See docs/plans/2026-05-04-markdown-first-artifacts-design.md for rationale.
 */

export interface Artifact {
  /** Canonical narrative (markdown). Audience: humans + downstream agents. */
  report: string;
  /** Deliverable content (markdown). Only present when an agent produces
   *  publishable content (article body, product description). Converted to
   *  HTML at the publish boundary via `markdownToHtml`. */
  body?: string;
  /** Structured contract: IDs, URLs, scheduling, routing, publish stamps.
   *  Free-form bag — keys agreed between producing agent and any consumer
   *  (publisher, tool-executor). Frontend ignores it apart from a small
   *  details panel. */
  refs?: Record<string, unknown>;
}

// ----- LEGACY (will be removed in Task 10) -----

export interface BlogArticleData {
  title: string;
  bodyHtml: string;
  summaryHtml: string;
  summary?: string;
  tags: string[];
  language: string;
  author?: string;
}

export interface BlogPublishedMeta {
  articleId: number;
  blogId: number;
  blogHandle: string;
  handle: string;
  articleUrl: string;
  publishedAt: string | null;
  status: 'published' | 'draft';
}

export interface ProductContentData {
  title: string;
  bodyHtml: string;
  summary?: string;
  tags: string[];
  vendor: string;
  productType?: string;
  language: string;
  imageUrls: string[];
}

export interface ProductPublishedMeta {
  productId: number;
  handle: string;
  adminUrl: string;
  status: 'active' | 'draft';
}

export interface SeoPlanTopic {
  title: string;
  primaryKeyword: string;
  language: string;
  writerBrief: string;
  assignedAgent: string;
  scheduledAt?: string;
  searchIntent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  paaQuestions: string[];
  relatedSearches: string[];
  competitorTopAngles: string[];
  competitorGaps: string[];
  targetWordCount: number;
  eeatHook: string;
}

export interface SeoPlanData {
  summary: string;
  topics: SeoPlanTopic[];
}

export interface ProductPlanVariant {
  title: string;
  platform?: string;
  language: string;
  marketingAngle: string;
  keyMessages: string[];
  copyBrief: {
    tone: string;
    featuresToHighlight: string[];
    forbiddenClaims: string[];
  };
  imagePlan: {
    purpose: string;
    styleHint: string;
    priority: 'required' | 'optional';
  }[];
  assignedAgent: 'product-designer';
  scheduledAt?: string;
}

export interface ProductPlanData {
  summary: string;
  variants: ProductPlanVariant[];
}

export interface EeatQuestion {
  question: string;
  hint?: string;
  optional?: boolean;
}

export interface EeatQuestionsData {
  summary?: string;
  questions: EeatQuestion[];
  askedAt: string;
}

export interface ClarificationData {
  question: string;
}

export type LegacyArtifact =
  | { kind: 'blog-article'; data: BlogArticleData; published?: BlogPublishedMeta }
  | { kind: 'product-content'; data: ProductContentData; published?: ProductPublishedMeta }
  | { kind: 'seo-plan'; data: SeoPlanData }
  | { kind: 'product-plan'; data: ProductPlanData }
  | { kind: 'eeat-questions'; data: EeatQuestionsData }
  | { kind: 'clarification'; data: ClarificationData };

export type LegacyArtifactKind = LegacyArtifact['kind'];
```

**Step 2: Update `src/tasks/output.ts`**

Replace the `artifact?: Artifact;` line so it accepts both:

```ts
import type { Artifact, LegacyArtifact } from './artifact.js';

// ...

export interface TaskOutput {
  /** Typed deliverable. New shape: { report, body?, refs? }.
   *  LegacyArtifact accepted during migration (removed in Task 10). */
  artifact?: Artifact | LegacyArtifact;

  // (rest unchanged)
}
```

**Step 3: Update `src/api/schemas.ts` — make `ArtifactSchema` accept both shapes**

Replace the existing `ArtifactSchema` definition with:

```ts
const NewArtifactSchema = z
  .object({
    report: z.string(),
    body: z.string().optional(),
    refs: z.record(z.unknown()).optional(),
  })
  .passthrough();

const LegacyArtifactSchema = z.discriminatedUnion('kind', [
  // (paste the existing six legacy variants here, unchanged)
]);

export const ArtifactSchema = z.union([NewArtifactSchema, LegacyArtifactSchema]);
```

The legacy variants (`blog-article`, `product-content`, `seo-plan`, `product-plan`, `eeat-questions`, `clarification`) stay exactly as today — copy-paste them under `LegacyArtifactSchema`. Migrating agents will gradually emit the new shape; both pass validation.

**Step 4: Run typecheck**

```bash
pnpm typecheck
```

Expected: clean. If `Artifact` references break in agent files, you missed Step 2 — `TaskOutput.artifact` must accept the union.

**Step 5: Run tests**

```bash
pnpm test
```

Expected: all green. No agent has migrated yet, so existing assertions still pass against `LegacyArtifact` shape.

**Step 6: Commit**

```bash
git add src/tasks/artifact.ts src/tasks/output.ts src/api/schemas.ts
git commit -m "refactor(artifact): introduce new flat shape alongside LegacyArtifact

$(printf 'New { report, body?, refs? } shape lives next to the discriminated\nunion. ArtifactSchema accepts both. Agents will migrate one at a\ntime in subsequent commits; Task 10 removes the legacy.\n')"
```

---

### Task 3: Migrate supervisor (clarification)

Smallest agent; only emits `report`, no body, no refs.

**Files:**
- Modify: `src/orchestrator/supervisor.ts`
- Modify: `tests/supervisor.test.ts`
- Modify: `tests/integration/lifecycle.test.ts` (clarification path assertions, if any)

**Step 1: Update test to expect new shape**

In `tests/supervisor.test.ts`, find the existing assertion (around line 131) that looks like:

```ts
data: { question: 'Could you clarify the target language?' },
```

Replace the `lastOutput.artifact` block with:

```ts
expect(result.lastOutput?.artifact).toEqual({
  report: expect.stringContaining('Could you clarify the target language?'),
});
```

(Adjust to whatever the test was previously asserting — drop `kind`/`data` and assert `report` is a string containing the clarification.)

**Step 2: Run the test, expect it to fail**

```bash
pnpm test -- tests/supervisor.test.ts
```

Expected: failure — supervisor still emits old shape.

**Step 3: Update supervisor**

In `src/orchestrator/supervisor.ts`, find the clarification return block (around line 87-101 — the `if (decision.clarification)` branch). Replace:

```ts
artifact: {
  kind: 'clarification',
  data: { question: decision.clarification },
},
```

with:

```ts
artifact: {
  report: `## 我需要再確認一下\n\n${decision.clarification}\n\n請補充更多資訊我才能往下做。`,
},
```

**Step 4: Run the test, expect pass**

```bash
pnpm test -- tests/supervisor.test.ts
```

Expected: pass.

**Step 5: Update integration tests touching the clarification path**

Search for old-shape assertions:

```bash
grep -rn "kind: 'clarification'" tests/
```

For each match (likely in `tests/integration/lifecycle.test.ts`), replace with assertions on `report` containing the question text. Run:

```bash
pnpm test:integration -- tests/integration/lifecycle.test.ts
```

Expected: pass.

**Step 6: Run full unit test suite**

```bash
pnpm test
```

Expected: all green (other agents still on LegacyArtifact and their assertions are unchanged).

**Step 7: Commit**

```bash
git add src/orchestrator/supervisor.ts tests/supervisor.test.ts tests/integration/lifecycle.test.ts
git commit -m "refactor(supervisor): emit Artifact{report} instead of clarification kind"
```

---

### Task 4: Migrate seo-strategist

**Files:**
- Modify: `src/agents/builtin/seo-strategist/index.ts`
- Modify: `tests/seo-strategist.test.ts`
- Modify: `tests/integration/seo-cluster.test.ts`
- Modify: `tests/integration/spawning.test.ts` (if it touches seo-plan shape)

**Step 1: Re-read the design doc — seo-strategist section**

`docs/plans/2026-05-04-markdown-first-artifacts-design.md` § Per-agent mapping → seo-strategist. Note:
- `report` = full markdown plan (TL;DR, market analysis, each topic as a section).
- `body` = absent (strategist has no deliverable to publish).
- `refs` = optional small bag (e.g., `topicsCount` for analytics — keep YAGNI; only add what's used).
- Each spawned child gets `input = { brief: <topic markdown>, refs: { primaryKeyword, language } }`.

**Step 2: Update the LLM output schema**

Find `PlanSchema` in `src/agents/builtin/seo-strategist/index.ts`. Each topic currently has `writerBrief` (string). Change `writerBrief` to be the **markdown brief** that gets passed to the writer child. Add a top-level `overview: string` field for the market-analysis section. Drop the structured `summary` (`overview` replaces it).

The agent code then:
- Builds `report = overview + "\n\n" + topics.map(t => "### " + t.title + "\n\n" + t.writerBrief).join("\n\n")`.
- Builds each spawn task: `input = { brief: t.writerBrief, refs: { primaryKeyword: t.primaryKeyword, language: t.language } }`.

**Step 3: Replace the artifact block in `invoke()`**

Find the `return {` block emitting `artifact: { kind: 'seo-plan', data: { summary: plan.summary, topics: ... } }`. Replace with:

```ts
const report = [plan.overview, ...plan.topics.map((t) => `### ${t.title}\n\n${t.writerBrief}`)].join(
  '\n\n',
);

return {
  message: plan.progressNote,
  awaitingApproval: true,
  artifact: { report },
  spawnTasks,
};
```

**Step 4: Update spawn input — pass markdown brief + minimal refs**

In the same file, the `spawnTasks` builder currently has:

```ts
input: {
  brief: t.writerBrief,
  primaryKeyword: t.primaryKeyword,
  language: t.language,
  research: { /* paaQuestions, ... */ },
},
```

Replace with:

```ts
input: {
  brief: t.writerBrief,  // markdown — this topic's section
  refs: {
    primaryKeyword: t.primaryKeyword,
    language: t.language,
  },
},
```

The downstream writer agent (Task 6) will read `input.params.brief` as markdown and pull `refs.primaryKeyword` for the structured fields it must hit exactly.

**Step 5: Update unit test**

In `tests/seo-strategist.test.ts`, find assertions on `artifact.kind === 'seo-plan'` / `artifact.data.topics`. Replace with:

```ts
expect(result.artifact).toEqual({
  report: expect.stringContaining('### '), // at least one topic heading
});
expect(result.spawnTasks).toBeDefined();
expect(result.spawnTasks?.[0]?.input).toMatchObject({
  brief: expect.any(String),
  refs: { primaryKeyword: expect.any(String), language: expect.any(String) },
});
```

**Step 6: Run unit test**

```bash
pnpm test -- tests/seo-strategist.test.ts
```

Expected: pass. If the LLM-mock returns the old plan shape, update the mock script in the test to return the new shape (`overview` + topics with markdown `writerBrief`).

**Step 7: Update integration tests**

```bash
grep -n "kind: 'seo-plan'\|artifact\.data\.topics\|research:" tests/integration/seo-cluster.test.ts tests/integration/spawning.test.ts
```

For each match, migrate to new shape:
- Old: `expect(output.artifact.data.topics.length).toBe(3)` → assert spawn count instead: `expect(spawnedTasks.length).toBe(3)`.
- Old: `expect(child.input.research.paaQuestions).toBeDefined()` → assert markdown brief: `expect(child.input.brief).toContain('PAA')` (since the markdown should mention the research findings).

```bash
pnpm test:integration -- tests/integration/seo-cluster.test.ts tests/integration/spawning.test.ts
```

Expected: pass.

**Step 8: Run full suite**

```bash
pnpm test && pnpm test:integration
```

**Step 9: Commit**

```bash
git add src/agents/builtin/seo-strategist/index.ts tests/seo-strategist.test.ts tests/integration/seo-cluster.test.ts tests/integration/spawning.test.ts
git commit -m "refactor(seo-strategist): emit Artifact{report}; pass markdown brief to children"
```

---

### Task 5: Migrate product-planner

Mirror of Task 4 with product-plan specifics.

**Files:**
- Modify: `src/agents/builtin/product-planner/index.ts`
- Modify: `tests/product-planner.test.ts`

**Step 1: Re-read the design doc — product-planner section**

`report` = market overview + each variant as a section. `body` = absent. Spawn input = `{ brief: variantSection, refs: { language, originalImageIds } }`.

**Step 2: Update the LLM output schema**

In `src/agents/builtin/product-planner/index.ts`, find `PlanSchema`. Each variant currently has structured `marketingAngle`, `keyMessages`, `copyBrief`, `imagePlan`. Add a `brief: string` field per variant — the markdown brief for the designer child — and change the agent to populate it from the structured fields (the LLM can be asked to emit both structured + markdown brief, or you can construct markdown server-side from the structured fields). Add top-level `overview: string`.

Recommended: ask LLM for both — `brief` (markdown — what the designer reads) AND the structured fields (used during spawn for analytics or future tooling). Keep them in `LegacyArtifact` shape internally only as long as needed; once you remove old assertions, clean up unused structured fields.

YAGNI tip: if no test or downstream code reads the structured `keyMessages`/`copyBrief`/`imagePlan` fields after this migration, drop them from `PlanSchema` entirely. The markdown `brief` is the only handoff.

**Step 3: Update artifact emission**

Same pattern as Task 4 Step 3. Replace `artifact: { kind: 'product-plan', data: ... }` with:

```ts
const report = [
  plan.overview,
  ...plan.variants.map((v) => `### ${v.title}\n\n${v.brief}`),
].join('\n\n');
return {
  message: plan.progressNote,
  awaitingApproval: true,
  artifact: { report },
  spawnTasks,
};
```

**Step 4: Update spawn input**

```ts
input: {
  brief: v.brief,   // markdown — designer reads this
  refs: {
    language: v.language,
    ...(originalImageIds.length > 0 ? { originalImageIds } : {}),
  },
},
```

**Step 5: Update unit test**

`tests/product-planner.test.ts`: same migration as Task 4 Step 5.

**Step 6: Run tests**

```bash
pnpm test -- tests/product-planner.test.ts
pnpm test && pnpm test:integration
```

Expected: pass.

**Step 7: Commit**

```bash
git add src/agents/builtin/product-planner/index.ts tests/product-planner.test.ts
git commit -m "refactor(product-planner): emit Artifact{report}; pass markdown brief to designer"
```

---

### Task 6: Migrate shopify-blog-writer (both stages)

Two artifact moments: stage 1 (E-E-A-T questions) and stage 2 (article).

**Files:**
- Modify: `src/agents/builtin/shopify-blog-writer/index.ts`
- Modify: `tests/integration/shopify-blog-writer.test.ts`
- Modify: `tests/integration/shopify-blog-writer-eeat.test.ts`

**Step 1: Re-read the design doc — shopify-blog-writer section**

Stage 1: `report` lists the questions in markdown ordered list, `refs.askedAt`. `eeatPending` flow flag stays on `task.output` (untouched).

Stage 2: `report` = decision narrative; `body` = article in markdown; `refs = { title, summaryHtml, tags, language, author? }`. `pendingToolCall.args.bodyHtml = markdownToHtml(body)`. After publish, `tool-executor` stamps `refs.published`.

**Step 2: Update the agent — stage 1 (questions)**

Find the stage-1 return that currently emits `artifact: { kind: 'eeat-questions', data: { ... } }`. Replace with:

```ts
const questionLines = questions
  .map((q, i) => `${i + 1}. **${q.question}**${q.hint ? ` — ${q.hint}` : ''}${q.optional ? ' *(選填)*' : ''}`)
  .join('\n');

const report = `## 我需要先請你回答幾個問題

為什麼要問：${questionsSummary ?? '這些細節能讓文章更有 E-E-A-T 信號。'}

${questionLines}

答完後我會把這些經驗融進文章裡。`;

return {
  message: progressNote,
  awaitingApproval: true,
  artifact: {
    report,
    refs: { askedAt: new Date().toISOString() },
  },
  // eeatPending stays exactly as today on top-level output:
  eeatPending: { questions, askedAt: new Date().toISOString() },
};
```

(Variable names depend on existing code — keep what's there, only swap the artifact shape.)

**Step 3: Update the agent — stage 2 (article)**

Find the stage-2 return emitting `artifact: { kind: 'blog-article', data: { ... } }` + `pendingToolCall`. Need to:

1. Have the LLM produce the article body as **markdown** (not HTML). Find `ArticleSchema` and change `bodyHtml: z.string()` to `body: z.string()`. Keep `summaryHtml` (Shopify excerpt is a separate short field; can stay HTML or become markdown — pick markdown for consistency, convert at boundary).
2. Replace the artifact block with:

```ts
import { markdownToHtml } from '../../lib/markdown.js';

// ...

const report = `# 文章寫好了：${article.title}

## 我的切入角度
${article.angleNote}

## 為什麼選這個標題
${article.titleRationale}

## E-E-A-T 強化
${article.eeatNotes}`;

const refs = {
  title: article.title,
  summaryHtml: article.summaryHtml,
  tags: article.tags,
  language: article.language,
  ...(article.author ? { author: article.author } : {}),
};

return {
  message: article.progressNote,
  awaitingApproval: true,
  artifact: { report, body: article.body, refs },
  pendingToolCall: {
    id: 'shopify.publish_article',
    args: {
      title: article.title,
      bodyHtml: markdownToHtml(article.body),
      summaryHtml: article.summaryHtml,
      tags: article.tags,
      blogHandle: cfg.shopify.blogHandle,
      publish: cfg.shopify.autoPublish,
    },
  },
};
```

The `report` fields (`angleNote`, `titleRationale`, `eeatNotes`) need to be added to `ArticleSchema` if not already there; if the LLM was producing one big `summary` markdown, you can map `report` directly to that and skip the per-section split.

**Step 4: Make sure stage 2 reads input.params from the new spawn shape**

The writer is spawned by seo-strategist with `input.params = { brief: <markdown>, refs: { primaryKeyword, language } }`. Find where the agent reads `input.params`. Replace structured `research.*` reads with:
- The markdown `input.params.brief` becomes context for the LLM (concat into the prompt).
- `input.params.refs?.primaryKeyword` enforces the keyword in the prompt.
- `input.params.refs?.language` controls language.

If the writer's prompt template currently interpolates `{{research.paaQuestions}}` or similar, change it to consume `{{brief}}` (the LLM reads paa questions from the brief markdown itself — they're embedded in the prose).

**Step 5: Update tests**

In `tests/integration/shopify-blog-writer.test.ts` and `tests/integration/shopify-blog-writer-eeat.test.ts`:
- Replace assertions on `output.artifact.kind === 'blog-article'` / `data.bodyHtml` with `output.artifact.report` / `output.artifact.body`.
- For `pendingToolCall.args.bodyHtml`, assert it contains expected HTML tags after markdown conversion (e.g., `<h1>` for `# heading`).
- Stage 1 test: assert `output.artifact.report` contains question text; `output.eeatPending.questions[0].question` still works.

**Step 6: Run tests**

```bash
pnpm test:integration -- tests/integration/shopify-blog-writer.test.ts tests/integration/shopify-blog-writer-eeat.test.ts
pnpm test && pnpm test:integration
```

Expected: pass. Note: if seo-cluster integration test (Task 4) spawns writer and asserts on the writer's output shape, that may also need an update here.

**Step 7: Commit**

```bash
git add src/agents/builtin/shopify-blog-writer/ tests/integration/shopify-blog-writer.test.ts tests/integration/shopify-blog-writer-eeat.test.ts
git commit -m "refactor(shopify-blog-writer): emit Artifact{report,body,refs}; convert HTML at publish boundary"
```

---

### Task 7: Migrate product-designer

**Files:**
- Modify: `src/agents/builtin/product-designer/index.ts`
- Modify: `src/agents/builtin/shopify-publisher/content.ts` (drop the `ProductContent` interface fields no longer needed; or keep and adapt)
- Modify: `tests/product-designer.test.ts`
- Modify: `tests/integration/product-publisher.test.ts`

**Step 1: Re-read the design doc — product-designer section**

`report` = decision narrative + inline images via `![alt](url)`. `body` = product description in markdown. `refs = { title, tags, vendor, productType?, language, imageUrls }`.

**Step 2: Update the LLM output schema**

In `src/agents/builtin/product-designer/index.ts`, find `ProductListingSchema`. Change `bodyHtml: z.string()` to `body: z.string()`. Drop or rename `summary` (it gets folded into `report`). Add `report: string` if you want the LLM to produce the narrative directly, or build it in code from existing fields.

**Step 3: Update artifact emission**

Replace the existing `artifact: { kind: 'product-content', data: { ... } }` block with:

```ts
const imageMarkdown = imageUrls
  .map((url, i) => `![圖 ${i + 1}](${url})`)
  .join('\n\n');

const report = `# 商品設計完成：${listing.title}

## 文案切角
${listing.angleNote}

## 我畫了哪些圖
${imageMarkdown}

${listing.imageNotes}`;

const refs = {
  title: listing.title,
  tags: listing.tags,
  vendor: listing.vendor,
  ...(listing.productType ? { productType: listing.productType } : {}),
  language: listing.language,
  imageUrls,
};

return {
  message: listing.progressNote,
  awaitingApproval: true,
  artifact: { report, body: listing.body, refs },
  payload: { content: { ...refs, body: listing.body, report } },  // for downstream publisher
  spawnTasks,
};
```

**Step 4: Update what publisher reads**

The product-designer spawns shopify-publisher with `input: { content }`. Adjust the `content` shape so publisher receives `{ report, body, refs }` (or pass the whole artifact). Update `src/agents/builtin/shopify-publisher/content.ts`:

```ts
export interface ProductContent {
  report: string;
  body: string;
  refs: {
    title: string;
    tags: string[];
    vendor: string;
    productType?: string;
    language: string;
    imageUrls: string[];
  };
}
```

Drop the old standalone `title`, `bodyHtml`, `summary`, etc. fields if they were duplicated.

**Step 5: Update unit + integration tests**

`tests/product-designer.test.ts` and `tests/integration/product-publisher.test.ts`:
- Replace `output.artifact.data.bodyHtml` → `output.artifact.body` (markdown).
- Replace `output.artifact.data.imageUrls` → `output.artifact.refs.imageUrls`.

**Step 6: Run tests**

```bash
pnpm test -- tests/product-designer.test.ts
pnpm test:integration -- tests/integration/product-publisher.test.ts
pnpm test && pnpm test:integration
```

Expected: pass. (Publisher itself migrates in Task 8 — its assertions in this file might still rely on old shape; if so, defer those test updates to Task 8.)

**Step 7: Commit**

```bash
git add src/agents/builtin/product-designer/ src/agents/builtin/shopify-publisher/content.ts tests/product-designer.test.ts tests/integration/product-publisher.test.ts
git commit -m "refactor(product-designer): emit Artifact{report,body,refs}; pass artifact-shaped content to publisher"
```

---

### Task 8: Migrate shopify-publisher

**Files:**
- Modify: `src/agents/builtin/shopify-publisher/index.ts`
- Modify: `tests/shopify-publisher.test.ts`
- Modify: `tests/integration/product-publisher.test.ts` (publisher-side assertions)

**Step 1: Re-read the design doc — shopify-publisher section**

Reads `task.input.params.content` (the artifact-shaped object from Task 7). Forwards it as own artifact, builds `pendingToolCall(shopify.create_product)` with `args.bodyHtml = markdownToHtml(content.body)`.

**Step 2: Update agent**

In `src/agents/builtin/shopify-publisher/index.ts`, replace the `invoke` body's artifact + pendingToolCall block with:

```ts
import { markdownToHtml } from '../../lib/markdown.js';

// ...

const content = input.params.content as ProductContent;

await ctx.emitLog('agent.started', '準備發佈商品內容', {
  title: content.refs.title,
  imageCount: content.refs.imageUrls.length,
});

const report = `## 準備發佈到 Shopify

${content.report}

---

我將以草稿/上架狀態送出，等老闆 approve 後實際呼叫 Shopify Admin API。`;

const pendingToolCall = {
  id: 'shopify.create_product',
  args: {
    title: content.refs.title,
    bodyHtml: markdownToHtml(content.body),
    tags: content.refs.tags,
    vendor: content.refs.vendor,
    ...(content.refs.productType ? { productType: content.refs.productType } : {}),
    ...(content.refs.imageUrls.length > 0
      ? { images: content.refs.imageUrls.map((url) => ({ url })) }
      : {}),
  },
};

return {
  message: '準備好上架，等你 approve',
  awaitingApproval: true,
  artifact: {
    report,
    body: content.body,
    refs: { ...content.refs, ready: true },
  },
  payload: { content },
  pendingToolCall,
};
```

**Step 3: Update tests**

Same migration pattern as previous tasks. In `tests/shopify-publisher.test.ts` find:

```ts
data: expect.objectContaining({  // line 60
```

Replace with assertions on the new flat shape:

```ts
expect(output.artifact).toMatchObject({
  report: expect.stringContaining('Shopify'),
  body: expect.any(String),
  refs: expect.objectContaining({
    title: 'Test Product',
    imageUrls: expect.arrayContaining([expect.any(String)]),
  }),
});
expect(output.pendingToolCall?.args.bodyHtml).toContain('<');  // converted HTML
```

**Step 4: Run tests**

```bash
pnpm test -- tests/shopify-publisher.test.ts
pnpm test:integration -- tests/integration/product-publisher.test.ts
pnpm test && pnpm test:integration
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/agents/builtin/shopify-publisher/ tests/shopify-publisher.test.ts tests/integration/product-publisher.test.ts
git commit -m "refactor(shopify-publisher): emit Artifact{report,body,refs}; convert HTML at boundary"
```

---

### Task 9: Update tool-executor — stamp `refs.published`

The post-HITL tool executor previously stamped published meta on `artifact.published` (legacy nested shape). Now it stamps onto `artifact.refs.published`.

**Files:**
- Modify: `src/orchestrator/tool-executor.ts`

**Step 1: Find current stamp logic**

```bash
grep -n "stampPublishedOnArtifact\|published:" src/orchestrator/tool-executor.ts
```

The helper currently dispatches on `current.kind === 'blog-article'` / `'product-content'`.

**Step 2: Replace stamp helper**

Replace `stampPublishedOnArtifact` with:

```ts
function stampPublishedOnArtifact(
  current: Artifact | LegacyArtifact | undefined,
  toolId: string,
  result: unknown,
): Artifact | LegacyArtifact | undefined {
  if (!current) return undefined;
  // New shape — stamp into refs.published.
  if ('report' in current) {
    return {
      ...current,
      refs: { ...(current.refs ?? {}), published: result },
    };
  }
  // Legacy shape — kept until Task 10 removes LegacyArtifact entirely.
  if (toolId === 'shopify.publish_article' && current.kind === 'blog-article') {
    return { ...current, published: result as BlogPublishedMeta };
  }
  if (toolId === 'shopify.create_product' && current.kind === 'product-content') {
    return { ...current, published: result as ProductPublishedMeta };
  }
  return current;
}
```

**Step 3: Update tests**

```bash
grep -rn "artifact\.published\|published: result" tests/
```

For each match, switch assertions: `output.artifact.published` → `output.artifact.refs.published`.

**Step 4: Run tests**

```bash
pnpm test && pnpm test:integration
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/orchestrator/tool-executor.ts tests/
git commit -m "refactor(tool-executor): stamp publish meta on artifact.refs.published"
```

---

### Task 10: Remove LegacyArtifact + tighten schema

After Tasks 3–9 every agent is on the new shape. Time to delete the migration scaffolding.

**Files:**
- Modify: `src/tasks/artifact.ts`
- Modify: `src/api/schemas.ts`
- Modify: `src/tasks/output.ts`
- Modify: `src/orchestrator/tool-executor.ts`

**Step 1: Verify no callsites still use legacy types**

```bash
grep -rn "LegacyArtifact\|kind: 'blog-article'\|kind: 'product-content'\|kind: 'seo-plan'\|kind: 'product-plan'\|kind: 'eeat-questions'\|kind: 'clarification'\|BlogArticleData\|ProductContentData\|SeoPlanData\|ProductPlanData\|EeatQuestionsData\|ClarificationData\|BlogPublishedMeta\|ProductPublishedMeta" src/ tests/
```

Expected: only `src/tasks/artifact.ts` (the type defs) and `src/orchestrator/tool-executor.ts` (the legacy stamp branch). Anything else means an agent or test was missed — go fix it before continuing.

**Step 2: Strip legacy from `src/tasks/artifact.ts`**

Delete every interface/type below the new `Artifact` interface (`BlogArticleData`, `BlogPublishedMeta`, `ProductContentData`, `ProductPublishedMeta`, `SeoPlanTopic`, `SeoPlanData`, `ProductPlanVariant`, `ProductPlanData`, `EeatQuestion`, `EeatQuestionsData`, `ClarificationData`, `LegacyArtifact`, `LegacyArtifactKind`).

The file should end up around 25 lines: just the `Artifact` interface and its doc comment.

**Step 3: Tighten `src/api/schemas.ts`**

Replace the union with the strict shape:

```ts
export const ArtifactSchema = z
  .object({
    report: z.string(),
    body: z.string().optional(),
    refs: z.record(z.unknown()).optional(),
  })
  .passthrough();
```

Delete `LegacyArtifactSchema` and `NewArtifactSchema` aliases.

**Step 4: Tighten `src/tasks/output.ts`**

Change `artifact?: Artifact | LegacyArtifact` back to `artifact?: Artifact` and drop the `LegacyArtifact` import.

**Step 5: Strip legacy branch from tool-executor**

In `src/orchestrator/tool-executor.ts`, remove the `if (toolId === 'shopify.publish_article' && current.kind === 'blog-article')` and `if (toolId === 'shopify.create_product' && current.kind === 'product-content')` branches. The helper now becomes:

```ts
function stampPublishedOnArtifact(
  current: Artifact | undefined,
  _toolId: string,
  result: unknown,
): Artifact | undefined {
  if (!current) return undefined;
  return {
    ...current,
    refs: { ...(current.refs ?? {}), published: result },
  };
}
```

(`_toolId` unused — keep it in the signature if callers still pass it; either rename to `_toolId` or drop the param entirely if call sites can be updated.)

**Step 6: Run typecheck + full suite**

```bash
pnpm typecheck && pnpm test && pnpm test:integration
```

Expected: clean. Any error here is a missed migration in Tasks 3–9.

**Step 7: Commit**

```bash
git add src/tasks/artifact.ts src/api/schemas.ts src/tasks/output.ts src/orchestrator/tool-executor.ts
git commit -m "refactor(artifact): drop LegacyArtifact and discriminated-union schemas"
```

---

### Task 11: Update API_GUIDE.md

The consumer-facing doc still describes the old discriminated union. Rewrite §5.1 (Artifact dispatch) for the new shape, refresh sample payloads, and update the TS types section.

**Files:**
- Modify: `docs/API_GUIDE.md`

**Step 1: Replace §5.1**

Find the section that describes the `Artifact` discriminated union and per-kind data shapes. Rewrite it to:

````markdown
### 5.1 Artifact contract

Every agent's deliverable lives at `task.output.artifact` with three fields:

```ts
interface Artifact {
  /** Markdown narrative — the canonical surface humans + downstream agents read.
   *  Render with a markdown component (e.g. <ReactMarkdown>). */
  report: string;
  /** Optional markdown deliverable (article body, product description). Only
   *  content-producing agents emit this. Render with the same markdown
   *  component beneath `report`. */
  body?: string;
  /** Free-form structured contract — IDs, URLs, scheduling, publish stamps.
   *  Producer-defined; UI shows it as a small details panel. After publishing,
   *  `refs.published` is stamped (e.g., `{ articleId, articleUrl, status }`). */
  refs?: Record<string, unknown>;
}
```

UI rendering:
1. Render `artifact.report` as markdown.
2. If `artifact.body` is present, render it below as markdown — that's the actual content.
3. If `artifact.refs?.published` is set, the publish step has completed; show a status badge or link.
4. Other `refs.*` keys are free-form — display selectively (e.g., a small "Details" toggle showing `imageUrls`, `tags`, etc.).

No per-agent dispatch needed. New agents introduce no new artifact types — they just write good markdown.
````

**Step 2: Refresh sample payloads**

Find every JSON example showing `output.artifact.kind` / `output.artifact.data`. Replace with samples in the new shape, e.g.:

```json
{
  "id": "...",
  "status": "waiting",
  "output": {
    "artifact": {
      "report": "# 文章寫好了：…\n\n## 我的切入角度\n…",
      "body": "# 投資理財入門指南\n\n…",
      "refs": {
        "title": "投資理財入門指南",
        "summaryHtml": "<p>給新手的 5 個第一步</p>",
        "tags": ["投資", "理財"],
        "language": "zh-TW"
      }
    },
    "pendingToolCall": { "id": "shopify.publish_article", "args": { ... } }
  }
}
```

**Step 3: Update TS types section**

Drop the per-data-kind interfaces (`BlogArticleData`, `ProductContentData`, etc.) and leave just the `Artifact` interface above.

**Step 4: Verify Swagger reflects the new shape**

Start the dev server and open `/docs`:

```bash
pnpm dev
# in another shell:
curl -sS http://127.0.0.1:8080/docs/json | jq '.components.schemas.Artifact'
```

Expected: a flat object schema with `report` (string, required), `body` (string, optional), `refs` (object, optional). If you still see an `anyOf`/`oneOf` discriminated union, Task 10 missed something.

Stop the server (Ctrl-C).

**Step 5: Commit**

```bash
git add docs/API_GUIDE.md
git commit -m "docs(api): rewrite §5.1 for flat Artifact shape; refresh sample payloads"
```

---

### Task 12: End-to-end smoke + final lint

**Files:** none (verification only).

**Step 1: Lint**

```bash
pnpm lint
```

Expected: clean. Fix any warnings.

**Step 2: Full test suite**

```bash
pnpm test:all
```

Expected: clean.

**Step 3: Build**

```bash
pnpm build
```

Expected: clean. Any TS error means a missed type narrowing.

**Step 4: Manual sanity (optional but recommended)**

If a Supabase instance is up, run the dev server and create a task via the API:

```bash
pnpm dev
# in another shell:
curl -sS -X POST http://127.0.0.1:8080/v1/tasks \
  -H "x-tenant-id: <test-tenant>" -H "Authorization: Bearer <test-token>" \
  -H "Content-Type: application/json" \
  -d '{"brief":"Write a quick test article about Shopify SEO."}' | jq '.output.artifact'
```

Expected: a response containing `report` (markdown string) and possibly `body` / `refs`. No `kind` / `data` keys.

Stop the server.

**Step 5: Commit (only if anything changed)**

If the lint step or smoke surfaced fixes:

```bash
git add -A
git commit -m "chore: final lint cleanup after artifact migration"
```

Otherwise the migration is done.

---

## Summary checklist

When the plan completes, verify all of:

- [ ] `pnpm typecheck && pnpm lint && pnpm test:all && pnpm build` all clean.
- [ ] `grep -rn "LegacyArtifact\|artifact\.kind\|artifact\.data" src/ tests/` returns nothing.
- [ ] `docs/API_GUIDE.md` §5.1 documents the flat shape.
- [ ] `/docs` Swagger shows `Artifact = { report, body?, refs? }` with no discriminator.
- [ ] Every agent's unit test asserts the new shape (`report`, optionally `body`, optionally `refs`).
- [ ] `tool-executor.ts` stamps `refs.published`, no kind dispatch.

If any item fails, the migration is incomplete — go back to the failing task and finish it.
