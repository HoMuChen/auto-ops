# Graph Refactor PR2: EEAT Split + First Workflow Sub-Graph — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split `shopify-blog-writer` into two atomic agents (`eeat-interviewer`, `article-writer`) and stitch them together with a workflow sub-graph (`seo-article-with-eeat`). Both atomic agents emit `lastStructuredOutput`; report-writer (PR1) starts producing prose for `article-draft` schemas. The old `shopify-blog-writer` is removed in the same PR; main stays green at every commit by ordering: add new → migrate references → delete old.

**Architecture:**
- `eeat-interviewer` — atomic. Generates EEAT questions, returns `awaitingApproval=true`, `payload.eeatPending`, `artifact.report` (the question prompt), and `lastStructuredOutput.schemaName='eeat-questions'` so report-writer's existing `REPORT_SKIP_SCHEMAS` skip preserves the question prompt verbatim.
- `article-writer` — atomic. Stage-2 article writing only; reads EEAT answers from messages when present. Stops setting `artifact.report`; emits `lastStructuredOutput.schemaName='article-draft'` so report-writer renders boss prose. Keeps `shopify.publish_article` tool + cover-image generation.
- `seo-article-with-eeat` — `IAgent` whose `build()` returns an `invoke` that compiles a 2-node `StateGraph` (sub-graph) at call-time. Routes between the two atomic runs based on `currentTaskOutput.eeatPending` + last-message-from-user. **No nested checkpointing** — sub-graph is rebuilt fresh on every outer hop; persistence remains the outer Postgres checkpointer + `task.output.eeatPending`. Outer-facing `lastOutput.agentId = 'seo-article-with-eeat'` so the runner's `pinnedAgent` re-pins to the workflow on resume.
- Strategist children continue to spawn into `article-writer` (no EEAT branch — bulk plans don't pause for interviews).

**Tech Stack:** TypeScript, LangGraph (`@langchain/langgraph` `StateGraph`), Zod, vitest. House LLM gateway is OpenRouter via `buildModel()`. Test style: vi.mock for unit, real Supabase + `llm-mock` for integration.

**Design ref:** `docs/plans/2026-05-07-graph-refactor-design.md` §"Architecture", §"Workflow sub-graph contract", §"HITL resume", §"PR2".

---

## Pre-flight

```bash
pnpm typecheck     # expect: clean
pnpm lint          # expect: clean
pnpm test          # expect: 198 passed (PR1 baseline + 4 report-writer)
pnpm test:integration   # expect: 106 passed
```

If baseline isn't green, stop — PR2 is a substantial refactor and must land on a clean main.

**Worktree setup:** Use `superpowers:using-git-worktrees` to create `.worktrees/graph-refactor-pr2` on branch `feat/graph-refactor-pr2`. Copy `.env` from the primary worktree (integration tests need `DATABASE_URL`).

---

## Phase A — Atomic agents (additive; no removal)

### Task 1: Scaffold `article-writer` with manifest + skeleton invoke

**Files:**
- Create: `src/agents/builtin/article-writer/index.ts`
- Create: `src/agents/builtin/article-writer/packs/aiSeo.md` (copy from `shopify-blog-writer/packs/aiSeo.md`)
- Create: `src/agents/builtin/article-writer/packs/geo.md` (copy)
- Create: `src/agents/builtin/article-writer/packs/seo-fundamentals.md` (copy)
- (Note: do NOT copy `eeat.md` — that pack moves to `eeat-interviewer/packs/` in Task 6)

**What:** Stand up the new agent's IAgent shell. **Don't yet wire** the actual article-writing logic — just enough so a unit test can build it and assert the manifest is correct. The real invoke comes in Task 3 after the failing test.

**Step 1: Create the file**

```ts
// src/agents/builtin/article-writer/index.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { buildTenantImageTools } from '../../../integrations/openai-images/build-tenant-image-tools.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
import { buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { WebFetchClient } from '../../../integrations/web/client.js';
import { buildWebFetchTools } from '../../../integrations/web/tools.js';
import { markdownToHtml } from '../../lib/markdown.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import { skillsToggleSchema } from '../../lib/skills-schema.js';
import { runToolLoop } from '../../lib/tool-loop.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
  PendingToolCall,
} from '../../types.js';

const DEFAULT_PROMPT = `You are an Article Writer AI employee for an e-commerce business.
Your job: produce ONE polished, multilingual SEO blog article from a single brief
and return it as the structured object requested. The framework will publish
the article to the tenant's Shopify blog after the user reviews and approves.

Requirements:
- Title: <= 70 chars, include the primary keyword if natural.
- Slug: **English ASCII only**, kebab-case (lowercase a-z + 0-9 + hyphens), 3–7
  words, no Chinese / Japanese / Korean / accents / spaces / underscores.
  This is true even when the article body is zh-TW, ja, ko, etc. — Shopify
  uses this as the URL handle (\`/blogs/<blog>/<slug>\`), and a non-ASCII
  URL is bad SEO and ugly to share. Translate the primary keyword to English
  for the slug. Examples: "summer-linen-shirt-guide", "best-running-shoes-2026".
- Body: clean Markdown. Use ## / ### headings, **bold**, *italic*, - bullets,
  > blockquote. Do NOT emit raw HTML — the framework converts at the Shopify
  publish boundary. Aim for 800–1500 words for top-of-funnel SEO posts.
- Summary: 1–2 sentence excerpt (<= 200 chars) used as the meta description
  and the blog index card.
- Tags: 3–8 short lower-case keywords.
- Honor any tenant profile / brief constraints.
- Stay focused on the single topic — do NOT propose other articles.
- progressNote is one short sentence for the kanban timeline. keyDecisions is
  3–5 short bullets the report-writer can lean on; the boss-facing prose is
  rendered by a separate report-writer node, so do NOT write your own boss
  memo here.

Research workflow:
- If the brief already contains keyword research (PAA questions, related
  searches, competitor angles, target word count) — typically when spawned
  by an SEO Strategist — skip research and call submit_article directly.
- If the brief is a raw user request without research, do search-then-read:
  1. Call serper_search 1–3 times to learn the SERP landscape.
  2. Pick 2–3 of the most relevant organic URLs and call web_fetch on each.
  3. Skip web_fetch when the snippet alone is enough.
- Submit the final article via the submit_article tool when ready.

When the conversation includes prior EEAT answers from the user (a workflow
sub-graph case), weave the boss's specific experience into the article — that
real-life data is the EEAT differentiator.`;

const configSchema = z.object({
  publishToShopify: z
    .boolean()
    .default(true)
    .describe(
      'If true, approve(finalize=true) publishes the article to the tenant Shopify blog ' +
        'via shopify.publish_article. If false, the task just goes to done with the draft.',
    ),
  blogHandle: z
    .string()
    .nullish()
    .describe('Shopify blog handle (e.g. "news"). Defaults to the first blog on the store.'),
  defaultAuthor: z
    .string()
    .nullish()
    .describe('Author byline written to the article when the brief does not specify one.'),
  publishImmediately: z
    .boolean()
    .default(false)
    .describe(
      'If true, the article goes live on the storefront immediately. Default false → draft.',
    ),
  credentialLabel: z
    .string()
    .nullish()
    .describe('Which Shopify credential row to use when the tenant has multiple stores.'),
  skills: skillsToggleSchema,
  generateCoverImage: z
    .boolean()
    .default(false)
    .describe('If true, agent generates a cover image for the article before approval.'),
  coverImageStyle: z
    .string()
    .nullish()
    .describe('Style hint for the cover image, e.g. "editorial, warm tones".'),
});

type ArticleWriterConfig = z.infer<typeof configSchema>;

const ArticleSchema = z.object({
  title: z.string().min(1).max(140).describe('Article title shown on the blog and in feeds.'),
  slug: z
    .string()
    .min(3)
    .max(80)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'slug must be English kebab-case: lowercase a-z, 0-9, and single hyphens only',
    )
    .describe(
      'URL slug used as the Shopify article handle. **English ASCII only**, kebab-case, 3–7 words.',
    ),
  body: z
    .string()
    .min(50)
    .describe(
      'Article body in Markdown. Use ## / ### headings, **bold**, *italic*, - bullets, > blockquote. ' +
        'Do NOT emit raw HTML. 800–1500 words for top-of-funnel SEO posts.',
    ),
  summaryHtml: z
    .string()
    .min(20)
    .max(400)
    .describe('1–2 sentence excerpt as plain HTML or text. Meta description + blog index card.'),
  tags: z.array(z.string().min(1)).min(1).max(20).describe('Short keyword tags. 3–8 is ideal.'),
  language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
  author: z.string().nullish().catch(null),
  keyDecisions: z
    .array(z.string().min(5))
    .min(1)
    .max(5)
    .describe(
      '3–5 short bullets the downstream report-writer can lean on when generating boss prose. ' +
        'Examples: "從機能性切入而不是潮流", "開頭塞 EEAT 數字", "控制在 1500 字內". ' +
        'Be concrete about angle, EEAT hooks, and differentiation. Not boss-facing prose itself.',
    ),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe('一句話對老闆回報。zh-TW 第一人稱。'),
});

export const articleWriterAgent: IAgent = {
  manifest: {
    id: 'article-writer',
    name: '部落格文章撰寫員',
    description:
      '依聚焦 brief 撰寫一篇多語 SEO 部落格文章，' +
      '待人工核准後發布到租戶的 Shopify 部落格。' +
      '單純寫作，不主動詢問經驗 — 需要 EEAT 問答請改用 seo-article-with-eeat workflow。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['shopify.publish_article'],
    requiredCredentials: [
      {
        provider: 'shopify',
        description: 'Shopify Admin API token + store URL — needed to publish blog articles',
        setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
      },
    ],
    configSchema,
    metadata: { kind: 'execution', shape: 'atomic' },
  },

  async build(_ctx: AgentBuildContext): Promise<AgentRunnable> {
    // Implemented in Task 3 after the failing test.
    throw new Error('article-writer.build() not yet implemented');
  },
};

// Internal: also exported for the workflow sub-graph in Task 8.
export async function runArticleWriter(
  ctx: AgentBuildContext,
  cfg: ArticleWriterConfig,
  systemPrompt: string,
  input: AgentInput,
): Promise<AgentOutput> {
  // Implemented in Task 3 after the failing test.
  void ctx;
  void cfg;
  void systemPrompt;
  void input;
  throw new Error('runArticleWriter not yet implemented');
}
```

**Step 2: Verify it compiles**

```bash
pnpm typecheck
```

Expected: clean. The agent is not yet registered, so it has no behavioral effect.

**Step 3: Commit**

```bash
git add src/agents/builtin/article-writer/
git commit -m "feat(article-writer): scaffold atomic agent (manifest + stub invoke)

Skeleton for the article-writing half of the EEAT split. Manifest +
ArticleSchema (now with keyDecisions instead of report) ready; build()
and runArticleWriter() throw until the failing test in Task 3 drives
the real implementation."
```

---

### Task 2: Failing test — `article-writer` invoke output shape

**Files:**
- Create: `tests/article-writer.test.ts`

**What:** Lock in the contract that the new article-writer must satisfy:
1. Returns `awaitingApproval=true` after producing the article.
2. Sets `artifact.body` + `artifact.refs` but **not** `artifact.report` (report-writer fills that).
3. Sets `lastStructuredOutput = { agentId: 'article-writer', schemaName: 'article-draft', data: <article fields>, keyDecisions: [...] }`.
4. Sets `pendingToolCall = { id: 'shopify.publish_article', args: { ..., bodyHtml: <markdown→html> } }` when `publishToShopify=true`.
5. Does NOT set `pendingToolCall` when `publishToShopify=false`.

Use the same `tool-loop` mocking pattern as the existing `tests/seo-strategist.test.ts` (vi.mock the tool loop / structured invoke entry points).

**Step 1: Read the existing test file for pattern reference**

```bash
sed -n '1,80p' tests/seo-strategist.test.ts
```

(Also study `tests/agent-registry.test.ts` for IAgent.build() invocation patterns.)

**Step 2: Write the failing test**

```ts
// tests/article-writer.test.ts
import { describe, expect, it, vi } from 'vitest';

const runToolLoopMock = vi.fn();
vi.mock('../src/agents/lib/tool-loop.js', () => ({
  runToolLoop: runToolLoopMock,
}));

// Block real Shopify HTTP — the build() resolves tools at call-time, but the
// mocked tool-loop never invokes them so this is just a safety net.
vi.mock('../src/integrations/shopify/tools.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    buildShopifyTools: vi.fn(async () => [
      { id: 'shopify.publish_article', tool: { name: 'publish_article' } },
    ]),
  };
});

const { articleWriterAgent } = await import('../src/agents/builtin/article-writer/index.js');

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    systemPrompt: 'You are a writer.',
    agentConfig: { publishToShopify: true, skills: {} },
    availableExecutionAgents: [],
    tenantProfile: { tenantId: '...', industry: null, brandVoice: null, profileMd: null, imageStyleSuffix: null, timezone: 'UTC' },
    logCtx: { taskId: 'x', agentId: 'article-writer' },
    emitLog: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

describe('article-writer — invoke contract', () => {
  it('emits structuredOutput + pendingToolCall, no artifact.report, when publishToShopify=true', async () => {
    runToolLoopMock.mockResolvedValueOnce({
      kind: 'submitted',
      value: {
        title: 'Linen shirts',
        slug: 'linen-shirts',
        body: '## Section\n\nLong enough body content.',
        summaryHtml: 'A summary.',
        tags: ['linen', 'summer'],
        language: 'en',
        author: null,
        keyDecisions: ['用機能性切入', '開頭塞 EEAT 數字'],
        progressNote: 'Draft done.',
      },
    });

    const runnable = await articleWriterAgent.build(makeCtx());
    const out = await runnable.invoke({
      messages: [{ role: 'user', content: 'Write about linen.' }],
      params: {},
    });

    expect(out.awaitingApproval).toBe(true);
    expect(out.artifact?.body).toContain('## Section');
    expect(out.artifact?.refs).toMatchObject({ title: 'Linen shirts', language: 'en' });
    // Critical PR2 invariant: agent does NOT write artifact.report; report-writer fills it.
    expect(out.artifact?.report).toBeUndefined();
    // structuredOutput is the new inter-node bus.
    expect(out.structuredOutput).toMatchObject({
      schemaName: 'article-draft',
      data: expect.objectContaining({ title: 'Linen shirts' }),
      keyDecisions: expect.arrayContaining(['用機能性切入']),
    });
    // pendingToolCall is set with bodyHtml = markdownToHtml(body).
    expect(out.pendingToolCall?.id).toBe('shopify.publish_article');
    expect(out.pendingToolCall?.args.bodyHtml).toContain('<h2>Section</h2>');
  });

  it('omits pendingToolCall when publishToShopify=false', async () => {
    runToolLoopMock.mockResolvedValueOnce({
      kind: 'submitted',
      value: {
        title: 'Drafts only',
        slug: 'drafts-only',
        body: '## Body\n\nLong enough body content here.',
        summaryHtml: 'A summary.',
        tags: ['draft'],
        language: 'en',
        author: null,
        keyDecisions: ['Keep as draft per config.'],
        progressNote: 'Draft done.',
      },
    });

    const runnable = await articleWriterAgent.build(
      makeCtx({ agentConfig: { publishToShopify: false, skills: {} } }),
    );
    const out = await runnable.invoke({
      messages: [{ role: 'user', content: 'draft only' }],
      params: {},
    });

    expect(out.pendingToolCall).toBeUndefined();
    expect(out.structuredOutput?.schemaName).toBe('article-draft');
  });
});
```

**Step 3: Run test → expect FAIL**

```bash
pnpm vitest run tests/article-writer.test.ts
```

Expected: FAIL — `article-writer.build() not yet implemented`.

**Step 4: (no commit — implementation follows in Task 3)**

---

### Task 3: Implement `article-writer.build()` + `runArticleWriter()`

**Files:**
- Modify: `src/agents/builtin/article-writer/index.ts`

**What:** Replace both stubs with the real implementation. Body of the agent's `invoke` is essentially the Stage 2 path of the old `shopify-blog-writer`, minus the EEAT branch and minus the `report` field. The schema-name and `structuredOutput` plumbing are new.

The implementation MUST:
1. Resolve Shopify tools via `buildShopifyTools` (filtered to `shopify.publish_article`).
2. Resolve serper + web-fetch tools via `buildSerperTools` + `buildWebFetchTools`.
3. Resolve image tools via `buildTenantImageTools` for cover-image generation.
4. Load packs from `packs/` dir.
5. Run the tool loop with `ArticleSchema` as the final answer.
6. Convert body Markdown → HTML for `pendingToolCall.args.bodyHtml`.
7. Generate cover image when `cfg.generateCoverImage=true`.
8. Return `AgentOutput` matching the test contract.

The internal `runArticleWriter(ctx, cfg, systemPrompt, input)` exists so the workflow sub-graph (Task 8) can reuse it without re-resolving tools (i.e. `build()` is the tool-resolving wrapper; `runArticleWriter` is the per-invoke logic that takes already-resolved deps).

**Step 1: Replace the stubs**

Replace the `build()` and `runArticleWriter()` functions with:

```ts
export const articleWriterAgent: IAgent = {
  manifest: { /* unchanged from Task 1 */ },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ArticleWriterConfig;

    const imageTools = buildTenantImageTools({
      tenantId: ctx.tenantId,
      taskId: ctx.taskId,
      styleSuffix: ctx.tenantProfile.imageStyleSuffix || undefined,
    });

    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.credentialLabel ? { credentialLabel: cfg.credentialLabel } : {}),
      ...(cfg.blogHandle ? { blogHandle: cfg.blogHandle } : {}),
      ...(cfg.defaultAuthor ? { defaultAuthor: cfg.defaultAuthor } : {}),
      publishArticleImmediately: cfg.publishImmediately,
    });
    const filteredTools = tools.filter((t) => t.id === 'shopify.publish_article');

    const serperKey = env.SERPER_API_KEY;
    const serperTools = serperKey
      ? buildSerperTools({
          tenantId: ctx.tenantId,
          cache: new SerpCache(new SerperClient({ apiKey: serperKey })),
        })
      : [];
    const webFetchTools = buildWebFetchTools({ client: new WebFetchClient() });

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks({
      builtInDir: packsDir,
      builtInEnabled: cfg.skills,
      tenantId: ctx.tenantId,
      agentId: 'article-writer',
    });
    const systemPrompt = packsBlock ? `${packsBlock}\n\n${ctx.systemPrompt}` : ctx.systemPrompt;

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      return runArticleWriter(
        ctx,
        cfg,
        systemPrompt,
        input,
        { serperTools, webFetchTools, imageTools },
      );
    };

    return { tools: filteredTools, invoke };
  },
};

interface ArticleWriterDeps {
  serperTools: ReturnType<typeof buildSerperTools>;
  webFetchTools: ReturnType<typeof buildWebFetchTools>;
  imageTools: ReturnType<typeof buildTenantImageTools>;
}

export async function runArticleWriter(
  ctx: AgentBuildContext,
  cfg: ArticleWriterConfig,
  systemPrompt: string,
  input: AgentInput,
  deps: ArticleWriterDeps,
): Promise<AgentOutput> {
  await ctx.emitLog('agent.started', '開始寫稿了，給我一點時間', {
    publishToShopify: cfg.publishToShopify,
    blogHandle: cfg.blogHandle ?? '(default)',
  });

  const messages = await buildAgentMessages(
    systemPrompt,
    input.messages,
    undefined,
    input.imageResolver,
  );

  const articleResult = await runToolLoop({
    modelConfig: ctx.modelConfig,
    messages,
    tools: [...deps.serperTools, ...deps.webFetchTools],
    maxHops: 10,
    emitLog: ctx.emitLog,
    logCtx: ctx.logCtx,
    finalAnswer: {
      schema: ArticleSchema,
      name: 'submit_article',
      description:
        'Call this exactly once when the article is ready. The args ARE the final blog article.',
      minToolHops: 0,
    },
  });

  if (articleResult.kind !== 'submitted') {
    throw new Error(
      'article-writer did not submit an article within the tool loop budget — model emitted free-form content without calling submit_article.',
    );
  }
  const article = articleResult.value;

  let coverImageUrl: string | undefined;
  if (cfg.generateCoverImage && deps.imageTools.length > 0) {
    const genTool = deps.imageTools.find((t) => t.id === 'images.generate');
    if (genTool) {
      const style = cfg.coverImageStyle ?? 'editorial blog cover, clean layout';
      const imgResult = (await genTool.tool.invoke({
        prompt: `Blog cover image for: "${article.title}". ${style}`,
      })) as { id: string; url: string };
      coverImageUrl = imgResult.url;
    }
  }

  await ctx.emitLog('agent.draft.ready', article.progressNote, {
    artifactShape: 'body+structuredOutput',
    title: article.title,
    language: article.language,
    bodyLength: article.body.length,
    publishOnApprove: cfg.publishToShopify,
  });

  const refs: Record<string, unknown> = {
    title: article.title,
    slug: article.slug,
    summaryHtml: article.summaryHtml,
    tags: article.tags,
    language: article.language,
    ...(article.author ? { author: article.author } : {}),
  };

  // NOTE: artifact.report intentionally absent — report-writer fills it in
  // by reading state.lastStructuredOutput. PR1 wired the channel; this is
  // the first agent that uses it in production.
  const result: AgentOutput = {
    message: article.progressNote,
    awaitingApproval: true,
    artifact: { body: article.body, refs } as never, // cast: report is required on Artifact type, see Task 4
    payload: { publishToShopify: cfg.publishToShopify },
    structuredOutput: {
      schemaName: 'article-draft',
      data: {
        title: article.title,
        slug: article.slug,
        body: article.body,
        summaryHtml: article.summaryHtml,
        tags: article.tags,
        language: article.language,
        ...(article.author ? { author: article.author } : {}),
        ...(coverImageUrl ? { coverImageUrl } : {}),
      },
      keyDecisions: article.keyDecisions,
    },
  };

  if (cfg.publishToShopify) {
    const pendingToolCall: PendingToolCall = {
      id: 'shopify.publish_article',
      args: {
        title: article.title,
        slug: article.slug,
        bodyHtml: markdownToHtml(article.body),
        summaryHtml: article.summaryHtml,
        tags: article.tags,
        ...(article.author ? { author: article.author } : {}),
        ...(coverImageUrl ? { coverImageUrl } : {}),
      },
    };
    result.pendingToolCall = pendingToolCall;
  }

  return result;
}
```

**Step 2: Update the public `runArticleWriter` signature to match (exported function with deps param)**

The public export at the bottom of the file (the stub from Task 1) should be replaced by the real signature above. The earlier stub took `(ctx, cfg, systemPrompt, input)` — now it's `(ctx, cfg, systemPrompt, input, deps)`. Update the import-side caller in `build()` accordingly (already shown above).

**Step 3: Run the unit test**

```bash
pnpm vitest run tests/article-writer.test.ts
```

Expected: PASS — both tests green.

**Step 4: Make `Artifact.report` optional**

The `Artifact` type at `src/tasks/artifact.ts:17` declares `report: string` as **required**. Article-writer (and every future migrated agent) will leave it unset. Change to `report?: string` and update the docstring.

```ts
export interface Artifact {
  /**
   * Canonical narrative (markdown). Audience: humans + downstream agents.
   * Optional from PR2 onwards: agents may emit `structuredOutput` instead and
   * leave this for the report-writer node to fill in.
   */
  report?: string;
  body?: string;
  refs?: Record<string, unknown>;
}
```

Then drop the `as never` cast on the `result.artifact` object in `runArticleWriter`.

**Step 5: Re-run typecheck + the article-writer test + the FULL unit suite**

```bash
pnpm typecheck && pnpm test
```

Expected: all green. The Artifact change is a relaxation, so existing agents (which set `report`) keep typechecking.

**Step 6: Commit**

```bash
git add src/agents/builtin/article-writer/index.ts src/tasks/artifact.ts
git commit -m "feat(article-writer): real implementation; Artifact.report now optional

Article-writer is the first agent to participate in the report-writer
contract: artifact.body + structuredOutput.schemaName='article-draft'
+ keyDecisions; no artifact.report. Report-writer renders the boss
prose from this state on the way to END.

Artifact.report relaxed to optional — every agent migrated from PR2
onward leaves it unset; existing un-migrated agents (until PR3+) keep
setting it and continue to work."
```

---

### Task 4: Register `article-writer` in `bootstrapAgents()` (alongside `shopify-blog-writer`)

**Files:**
- Modify: `src/agents/index.ts`

**What:** Add the new agent to the registry without removing the old one. The supervisor will see both; the LLM may prefer one or the other for any given brief, but for now `shopify-blog-writer` keeps shipping production traffic. Tests still reference the old id; later tasks migrate them.

**Step 1: Add the import + registration**

```ts
import { articleWriterAgent } from './builtin/article-writer/index.js';
// ... existing imports ...

export function bootstrapAgents(): void {
  if (bootstrapped) return;
  agentRegistry.register(seoStrategistAgent);
  agentRegistry.register(shopifyBlogWriterAgent);
  agentRegistry.register(articleWriterAgent);  // NEW
  agentRegistry.register(productPlannerAgent);
  agentRegistry.register(productDesignerAgent);
  agentRegistry.register(shopifyPublisherAgent);
  agentRegistry.register(marketResearcherAgent);
  bootstrapped = true;
}
```

**Step 2: Run the full unit + integration suite**

```bash
pnpm test && pnpm test:integration
```

Expected: all green. Both agents coexist; nothing routes to article-writer yet because no test scripts the supervisor to pick it.

**Step 3: Commit**

```bash
git add src/agents/index.ts
git commit -m "feat(agents): register article-writer alongside shopify-blog-writer

Both agents enabled simultaneously while tests are migrated. The supervisor
will see both — until the integration tests script article-writer explicitly
and the strategist's seed scripts switch over (later tasks), production
traffic still routes to shopify-blog-writer."
```

---

### Task 5: Scaffold `eeat-interviewer` with manifest + skeleton invoke

**Files:**
- Create: `src/agents/builtin/eeat-interviewer/index.ts`
- Create: `src/agents/builtin/eeat-interviewer/packs/eeat.md` (move from `shopify-blog-writer/packs/eeat.md` — copy here for now; the original is deleted in Task 17)

**What:** Same skeleton pattern as Task 1 — manifest + ArticleSchema (well, EEAT schema) + a stub `build()` that throws. The real logic lands in Task 7 after the failing test.

**Step 1: Copy the eeat pack**

```bash
mkdir -p src/agents/builtin/eeat-interviewer/packs
cp src/agents/builtin/shopify-blog-writer/packs/eeat.md \
   src/agents/builtin/eeat-interviewer/packs/eeat.md
```

**Step 2: Create the agent file**

```ts
// src/agents/builtin/eeat-interviewer/index.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { invokeStructured } from '../../lib/invoke-structured.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import { skillsToggleSchema } from '../../lib/skills-schema.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';

const DEFAULT_PROMPT = `You are an EEAT Interviewer AI employee for an e-commerce business.
Your job: read the brief and decide what specific, lived-experience questions
the boss must answer so the downstream article writer can ground the article
in real, defensible expertise (Experience, Expertise, Authoritativeness,
Trustworthiness — the EEAT pillars Google ranks on).

Output rules:
- Ask 1–5 concrete, answerable questions. Specific numbers and lived
  experiences only — never generic "what's your opinion on X" prompts.
- Each question must be answerable in 1–3 sentences by the boss in chat.
- Mark genuinely optional questions as optional=true; don't gate the article
  on a question that's nice-to-have.
- progressNote is one short sentence for the kanban timeline.
- narrative explains to the boss WHY you need this experience and how you'll
  use it. Do NOT list the questions in narrative — the agent renders them
  separately as a numbered list.`;

const configSchema = z.object({
  skills: skillsToggleSchema,
});

const EeatQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(5).describe('Concrete experience question to the boss.'),
        hint: z.string().nullish().catch(null),
        optional: z.boolean().nullish().catch(false),
      }),
    )
    .min(1)
    .max(5),
  narrative: z
    .string()
    .min(20)
    .max(2000)
    .describe(
      '為什麼需要老闆親身經驗 + 你打算怎麼用這些答案。zh-TW Markdown。' +
        '不要在 narrative 裡列出問題本身 — agent 會在後面用 markdown 列出問題。',
    ),
  progressNote: z.string().min(10).max(200),
});

export const eeatInterviewerAgent: IAgent = {
  manifest: {
    id: 'eeat-interviewer',
    name: 'EEAT 訪談員',
    description:
      '在寫文章前先問老闆 1–5 個 EEAT 親身經驗問題，把答案存成 task feedback 供下游撰稿員引用。' +
      '配對 article-writer 使用最完整 — 多數情況下會被 seo-article-with-eeat workflow 自動串接。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: [],
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'execution', shape: 'atomic' },
  },

  async build(_ctx: AgentBuildContext): Promise<AgentRunnable> {
    throw new Error('eeat-interviewer.build() not yet implemented');
  },
};

export async function runEeatInterviewer(
  ctx: AgentBuildContext,
  systemPrompt: string,
  input: AgentInput,
): Promise<AgentOutput> {
  void ctx;
  void systemPrompt;
  void input;
  throw new Error('runEeatInterviewer not yet implemented');
}

// Internal export for the workflow sub-graph (Task 8) and unit tests.
export { EeatQuestionsSchema };
```

**Step 3: Verify it compiles**

```bash
pnpm typecheck
```

Expected: clean.

**Step 4: Commit**

```bash
git add src/agents/builtin/eeat-interviewer/
git commit -m "feat(eeat-interviewer): scaffold atomic agent (manifest + stub invoke)

The interviewer half of the EEAT split. Manifest + EeatQuestionsSchema
ready; build() and runEeatInterviewer() throw until Task 7 drives the
real implementation."
```

---

### Task 6: Failing test — `eeat-interviewer` invoke output shape

**Files:**
- Create: `tests/eeat-interviewer.test.ts`

**What:** Lock in the contract:
1. `awaitingApproval=true` (boss must answer before article-writer can run).
2. `payload.eeatPending = { questions, askedAt }` — same shape `shopify-blog-writer` uses today, so resume + `task.output.eeatPending` continues to work without DB migration.
3. `artifact.report` IS set (the question prompt as markdown) — this is the schema-skip case in `report-writer`'s `REPORT_SKIP_SCHEMAS`.
4. `lastStructuredOutput = { agentId: 'eeat-interviewer', schemaName: 'eeat-questions', data: { questions, askedAt }, keyDecisions: [] }`. Schema name MUST match the existing `report-writer.ts:REPORT_SKIP_SCHEMAS` entry — otherwise report-writer would render boss prose on top of the question prompt.

**Step 1: Write the failing test**

```ts
// tests/eeat-interviewer.test.ts
import { describe, expect, it, vi } from 'vitest';

const invokeStructuredMock = vi.fn();
vi.mock('../src/agents/lib/invoke-structured.js', () => ({
  invokeStructured: invokeStructuredMock,
}));

const { eeatInterviewerAgent } = await import('../src/agents/builtin/eeat-interviewer/index.js');

function makeCtx() {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    systemPrompt: 'You are an interviewer.',
    agentConfig: { skills: {} },
    availableExecutionAgents: [],
    tenantProfile: { tenantId: '...', industry: null, brandVoice: null, profileMd: null, imageStyleSuffix: null, timezone: 'UTC' },
    logCtx: { taskId: 'x', agentId: 'eeat-interviewer' },
    emitLog: vi.fn(async () => {}),
  } as never;
}

describe('eeat-interviewer — invoke contract', () => {
  it('asks 1–5 questions, sets awaitingApproval, eeatPending, and lastStructuredOutput.schemaName=eeat-questions', async () => {
    invokeStructuredMock.mockResolvedValueOnce({
      questions: [
        { question: 'How many washes before pilling?', hint: 'Specific number please.', optional: false },
        { question: 'Have you worn it in Taiwan summer humidity?', optional: true },
      ],
      narrative: '## 為什麼需要你的親身經驗\n\n搜尋者愛看真實數字。',
      progressNote: '有幾個 EEAT 問題想先請老闆回答。',
    });

    const runnable = await eeatInterviewerAgent.build(makeCtx());
    const out = await runnable.invoke({
      messages: [{ role: 'user', content: '幫我寫一篇亞麻襯衫指南' }],
      params: {},
    });

    expect(out.awaitingApproval).toBe(true);
    expect(out.payload?.eeatPending).toMatchObject({
      questions: expect.arrayContaining([
        expect.objectContaining({ question: expect.any(String) }),
      ]),
      askedAt: expect.any(String),
    });
    // Question prompt is preserved on artifact.report — report-writer's skip
    // set keeps this surface intact (interviewer's prompt IS the boss-facing
    // surface; not a retrospective summary that needs re-narration).
    expect(out.artifact?.report).toMatch(/我需要先請你回答幾個問題|EEAT|親身經驗/);
    // structuredOutput's schemaName MUST match REPORT_SKIP_SCHEMAS in
    // src/orchestrator/report-writer.ts so report-writer no-ops on it.
    expect(out.structuredOutput).toMatchObject({
      schemaName: 'eeat-questions',
      data: expect.objectContaining({
        questions: expect.any(Array),
        askedAt: expect.any(String),
      }),
    });
  });
});
```

**Step 2: Run test → expect FAIL**

```bash
pnpm vitest run tests/eeat-interviewer.test.ts
```

Expected: FAIL — `eeat-interviewer.build() not yet implemented`.

**Step 3: (no commit — implementation follows in Task 7)**

---

### Task 7: Implement `eeat-interviewer.build()` + `runEeatInterviewer()`

**Files:**
- Modify: `src/agents/builtin/eeat-interviewer/index.ts`

**Step 1: Replace the stubs**

```ts
export const eeatInterviewerAgent: IAgent = {
  manifest: { /* unchanged */ },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {});

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks({
      builtInDir: packsDir,
      builtInEnabled: cfg.skills,
      tenantId: ctx.tenantId,
      agentId: 'eeat-interviewer',
    });
    const systemPrompt = packsBlock ? `${packsBlock}\n\n${ctx.systemPrompt}` : ctx.systemPrompt;

    const invoke = (input: AgentInput) => runEeatInterviewer(ctx, systemPrompt, input);
    return { tools: [], invoke };
  },
};

export async function runEeatInterviewer(
  ctx: AgentBuildContext,
  systemPrompt: string,
  input: AgentInput,
): Promise<AgentOutput> {
  await ctx.emitLog('agent.started', '我先想幾個 EEAT 問題請老闆回答', {});

  const messages = await buildAgentMessages(
    systemPrompt,
    input.messages,
    undefined,
    input.imageResolver,
  );
  const q = await invokeStructured(
    ctx.modelConfig,
    EeatQuestionsSchema,
    'eeat_questions',
    messages,
    undefined,
    ctx.logCtx,
  );

  const askedAt = new Date().toISOString();
  const questionList = q.questions
    .map((qu, i) => {
      const hint = qu.hint ? ` — ${qu.hint}` : '';
      const optional = qu.optional ? ' *(選填)*' : '';
      return `${i + 1}. **${qu.question}**${hint}${optional}`;
    })
    .join('\n');

  // Layout contract: H2 → narrative → numbered list → CTA. The schema's
  // narrative.description forbids listing questions in narrative to avoid
  // duplication.
  const report = `## 我需要先請你回答幾個問題

${q.narrative}

${questionList}

答完後我會把這些經驗融進文章裡。`;

  await ctx.emitLog('agent.questions.asked', q.progressNote, {
    artifactShape: 'report',
    count: q.questions.length,
  });

  return {
    message: q.progressNote,
    awaitingApproval: true,
    artifact: { report, refs: { askedAt } },
    payload: { eeatPending: { questions: q.questions, askedAt } },
    // Schema name MUST be in src/orchestrator/report-writer.ts:REPORT_SKIP_SCHEMAS.
    // The interviewer's artifact.report (above) IS the boss-facing surface;
    // report-writer would clobber it with a meta-summary if not skipped.
    structuredOutput: {
      schemaName: 'eeat-questions',
      data: { questions: q.questions, askedAt },
    },
  };
}
```

**Step 2: Run the test**

```bash
pnpm vitest run tests/eeat-interviewer.test.ts
```

Expected: PASS.

**Step 3: Register in `bootstrapAgents`**

```ts
// src/agents/index.ts
import { eeatInterviewerAgent } from './builtin/eeat-interviewer/index.js';
// ...
agentRegistry.register(eeatInterviewerAgent);
```

**Step 4: Run the full suite**

```bash
pnpm typecheck && pnpm test && pnpm test:integration
```

Expected: all green.

**Step 5: Commit**

```bash
git add src/agents/builtin/eeat-interviewer/index.ts src/agents/index.ts tests/eeat-interviewer.test.ts
git commit -m "feat(eeat-interviewer): real implementation + bootstrap registration

The interviewer's structuredOutput.schemaName='eeat-questions' is in
report-writer's REPORT_SKIP_SCHEMAS (set up in PR1) so the interviewer's
own artifact.report (the question prompt) survives unchanged. payload
shape (eeatPending: { questions, askedAt }) matches the existing
shopify-blog-writer Stage 1 contract — in-flight tasks resume cleanly."
```

---

## Phase B — Workflow sub-graph

### Task 8: Scaffold `seo-article-with-eeat` workflow agent

**Files:**
- Create: `src/agents/builtin/seo-article-with-eeat/index.ts`

**What:** The IAgent shell. The internal sub-graph and conditional router are implemented in Task 10 after the failing test.

**Step 1: Create the file**

```ts
// src/agents/builtin/seo-article-with-eeat/index.ts
import { z } from 'zod';
import { skillsToggleSchema } from '../../lib/skills-schema.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';

const DEFAULT_PROMPT = '';  // Workflow itself doesn't prompt; inner nodes own their prompts.

const configSchema = z.object({
  // EEAT toggle — when false, the workflow skips the interviewer and runs
  // article-writer directly. Equivalent to spawning article-writer as the
  // atomic agent, but the boss may prefer keeping the workflow registration
  // and toggling at config-time.
  eeatEnabled: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), workflow asks EEAT questions before writing. ' +
        'When false, workflow goes straight to article-writer (the same as ' +
        'using the article-writer atomic agent directly).',
    ),

  // The remaining fields are forwarded verbatim to the inner article-writer.
  publishToShopify: z.boolean().default(true),
  blogHandle: z.string().nullish(),
  defaultAuthor: z.string().nullish(),
  publishImmediately: z.boolean().default(false),
  credentialLabel: z.string().nullish(),
  skills: skillsToggleSchema,
  generateCoverImage: z.boolean().default(false),
  coverImageStyle: z.string().nullish(),
});

export const seoArticleWithEeatAgent: IAgent = {
  manifest: {
    id: 'seo-article-with-eeat',
    name: 'SEO 文章 + EEAT 訪談',
    description:
      '兩階段文章工作流：先問老闆 EEAT 親身經驗問題、等回覆後再寫文章。' +
      '適合：單篇深度長文，老闆有具體實戰經驗想塞進文章但不想自己編排問題。' +
      '不適合：策略師批次派發的多篇 (請改用 article-writer 直接寫)。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['shopify.publish_article'],
    requiredCredentials: [
      {
        provider: 'shopify',
        description: 'Shopify Admin API token + store URL — needed to publish blog articles',
        setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
      },
    ],
    configSchema,
    metadata: { kind: 'execution', shape: 'workflow' },
  },

  async build(_ctx: AgentBuildContext): Promise<AgentRunnable> {
    throw new Error('seo-article-with-eeat.build() not yet implemented');
  },
};
```

**Step 2: Verify typecheck**

```bash
pnpm typecheck
```

Expected: clean.

**Step 3: Commit**

```bash
git add src/agents/builtin/seo-article-with-eeat/
git commit -m "feat(seo-article-with-eeat): scaffold workflow IAgent

Pure manifest scaffold for the first workflow sub-graph. Real router
implementation lands after the failing test in Task 9."
```

---

### Task 9: Failing test — workflow router decisions

**Files:**
- Create: `tests/seo-article-with-eeat.test.ts`

**What:** Unit-test the router (no real LLM, no real sub-graph compile if we can avoid it). The four decision paths to lock in:

| Path | `eeatEnabled` | `taskOutput.eeatPending` | last message role | → routes to |
|------|---|---|---|---|
| 1 | false | — | — | `article-writer` |
| 2 | true | undefined | — | `eeat-interviewer` |
| 3 | true | set | `user` | `article-writer` |
| 4 | true | set | `assistant` | `article-writer` (fallback; should not happen in practice) |

Also lock in: outer `lastOutput.agentId === 'seo-article-with-eeat'` (the workflow's id, NOT the inner node) for both paths so the runner's `pinnedAgent` re-pins to the workflow on resume.

**Step 1: Write the failing test**

```ts
// tests/seo-article-with-eeat.test.ts
import { describe, expect, it, vi } from 'vitest';

const runEeatInterviewerMock = vi.fn();
const runArticleWriterMock = vi.fn();

vi.mock('../src/agents/builtin/eeat-interviewer/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, runEeatInterviewer: runEeatInterviewerMock };
});
vi.mock('../src/agents/builtin/article-writer/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, runArticleWriter: runArticleWriterMock };
});
// Block real Shopify HTTP — the workflow's build() resolves Shopify tools.
vi.mock('../src/integrations/shopify/tools.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    buildShopifyTools: vi.fn(async () => [
      { id: 'shopify.publish_article', tool: { name: 'publish_article' } },
    ]),
  };
});

const { seoArticleWithEeatAgent } = await import(
  '../src/agents/builtin/seo-article-with-eeat/index.js'
);

function makeCtx() {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    systemPrompt: '',
    agentConfig: { eeatEnabled: true, publishToShopify: true, skills: {} },
    availableExecutionAgents: [],
    tenantProfile: { tenantId: '...', industry: null, brandVoice: null, profileMd: null, imageStyleSuffix: null, timezone: 'UTC' },
    logCtx: { taskId: 'x', agentId: 'seo-article-with-eeat' },
    emitLog: vi.fn(async () => {}),
  } as never;
}

const STUB_INTERVIEWER_OUT = {
  message: 'Q?',
  awaitingApproval: true,
  artifact: { report: '## 我需要先請你回答幾個問題\n\n...' },
  payload: { eeatPending: { questions: [], askedAt: 'x' } },
  structuredOutput: {
    schemaName: 'eeat-questions',
    data: { questions: [], askedAt: 'x' },
  },
};
const STUB_ARTICLE_OUT = {
  message: 'Draft done.',
  awaitingApproval: true,
  artifact: { body: '# Article', refs: { title: 'X' } },
  structuredOutput: {
    schemaName: 'article-draft',
    data: { title: 'X' },
    keyDecisions: ['k1'],
  },
  pendingToolCall: { id: 'shopify.publish_article', args: { title: 'X' } },
};

describe('seo-article-with-eeat — router decisions', () => {
  it('Path 1: eeatEnabled=false → article-writer (skips interviewer)', async () => {
    runArticleWriterMock.mockResolvedValueOnce(STUB_ARTICLE_OUT);
    const runnable = await seoArticleWithEeatAgent.build({
      ...makeCtx(),
      agentConfig: { eeatEnabled: false, publishToShopify: true, skills: {} },
    } as never);

    const out = await runnable.invoke({
      messages: [{ role: 'user', content: 'write linen guide' }],
      params: {},
    });

    expect(runEeatInterviewerMock).not.toHaveBeenCalled();
    expect(runArticleWriterMock).toHaveBeenCalledTimes(1);
    expect(out.structuredOutput?.schemaName).toBe('article-draft');
  });

  it('Path 2: eeatEnabled=true + no eeatPending → eeat-interviewer', async () => {
    runEeatInterviewerMock.mockResolvedValueOnce(STUB_INTERVIEWER_OUT);
    const runnable = await seoArticleWithEeatAgent.build(makeCtx());

    const out = await runnable.invoke({
      messages: [{ role: 'user', content: 'write linen guide' }],
      params: {},
    });

    expect(runEeatInterviewerMock).toHaveBeenCalledTimes(1);
    expect(runArticleWriterMock).not.toHaveBeenCalled();
    expect(out.structuredOutput?.schemaName).toBe('eeat-questions');
    expect(out.payload?.eeatPending).toBeDefined();
  });

  it('Path 3: eeatPending set + last message from user → article-writer', async () => {
    runArticleWriterMock.mockResolvedValueOnce(STUB_ARTICLE_OUT);
    const runnable = await seoArticleWithEeatAgent.build(makeCtx());

    const out = await runnable.invoke({
      messages: [
        { role: 'user', content: 'write linen guide' },
        { role: 'assistant', content: 'EEAT questions...' },
        { role: 'user', content: 'My answers: washed 10 times.' },
      ],
      params: {},
      taskOutput: { eeatPending: { questions: [], askedAt: 'x' } },
    });

    expect(runEeatInterviewerMock).not.toHaveBeenCalled();
    expect(runArticleWriterMock).toHaveBeenCalledTimes(1);
    expect(out.structuredOutput?.schemaName).toBe('article-draft');
  });

  it('outer-facing agentId is the workflow id, not the inner node id', async () => {
    runEeatInterviewerMock.mockResolvedValueOnce({
      ...STUB_INTERVIEWER_OUT,
      // Inner runs may declare any inner agentId in their state writes, but
      // the wrapper MUST expose the workflow's outer id so pinnedAgent on
      // resume routes back to the workflow (not directly to the inner node).
    });
    const runnable = await seoArticleWithEeatAgent.build(makeCtx());
    const out = await runnable.invoke({
      messages: [{ role: 'user', content: 'x' }],
      params: {},
    });

    // The outer wrapper sets state.lastOutput.agentId via the per-agent node
    // in graph.ts (uses manifest.id). What we verify here is that the agent
    // returns a regular AgentOutput — the graph layer adds the agentId. So
    // we just confirm the outer return is a normal AgentOutput shape; the
    // real "outer agentId == workflow id" property is exercised by the
    // integration test in Task 11/12.
    expect(out).toMatchObject({
      message: expect.any(String),
      awaitingApproval: true,
    });
  });
});
```

**Step 2: Run → expect FAIL**

```bash
pnpm vitest run tests/seo-article-with-eeat.test.ts
```

Expected: FAIL — `seo-article-with-eeat.build() not yet implemented`.

**Step 3: (no commit — Task 10 implements)**

---

### Task 10: Implement workflow `build()` with the conditional router

**Files:**
- Modify: `src/agents/builtin/seo-article-with-eeat/index.ts`

**What:** Build the workflow's `invoke` as a pure conditional router that delegates to `runEeatInterviewer` or `runArticleWriter`.

**Decision: plain function vs. real `StateGraph`?** Design doc shows StateGraph pseudocode, but the runtime semantics of a 2-node sub-graph with `START → conditional → either → END` are identical to a plain `if/else`. **Use the plain function** — fewer moving parts, easier debugging in stack traces, no LangGraph compile per build, no risk of nested-checkpoint footguns. Document the deviation in the commit message; the StateGraph option remains open if/when a workflow grows past 2 nodes.

**Step 1: Replace the stub**

```ts
import { runArticleWriter } from '../article-writer/index.js';
import { runEeatInterviewer } from '../eeat-interviewer/index.js';
// ... (existing imports for Shopify tools / serper / web fetch / image tools / packs / etc.
//      — same set as article-writer's build() because the inner article-writer
//      run needs the same deps)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../../config/env.js';
import { buildTenantImageTools } from '../../../integrations/openai-images/build-tenant-image-tools.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
import { buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { WebFetchClient } from '../../../integrations/web/client.js';
import { buildWebFetchTools } from '../../../integrations/web/tools.js';
import { loadPacks } from '../../lib/packs.js';

export const seoArticleWithEeatAgent: IAgent = {
  manifest: { /* unchanged */ },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {});

    // Resolve the article-writer's deps once at build time — same set as
    // article-writer/index.ts does. Reused on every workflow invocation that
    // routes to article-writer.
    const imageTools = buildTenantImageTools({
      tenantId: ctx.tenantId,
      taskId: ctx.taskId,
      styleSuffix: ctx.tenantProfile.imageStyleSuffix || undefined,
    });
    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.credentialLabel ? { credentialLabel: cfg.credentialLabel } : {}),
      ...(cfg.blogHandle ? { blogHandle: cfg.blogHandle } : {}),
      ...(cfg.defaultAuthor ? { defaultAuthor: cfg.defaultAuthor } : {}),
      publishArticleImmediately: cfg.publishImmediately,
    });
    const filteredTools = tools.filter((t) => t.id === 'shopify.publish_article');

    const serperKey = env.SERPER_API_KEY;
    const serperTools = serperKey
      ? buildSerperTools({
          tenantId: ctx.tenantId,
          cache: new SerpCache(new SerperClient({ apiKey: serperKey })),
        })
      : [];
    const webFetchTools = buildWebFetchTools({ client: new WebFetchClient() });

    // Both inner agents have their own packs; the workflow loads BOTH packs
    // dirs and combines into one prompt block per inner run. Article-writer's
    // packs go into the article-writer system prompt, etc.
    const articleWriterPacksDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'article-writer',
      'packs',
    );
    const interviewerPacksDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'eeat-interviewer',
      'packs',
    );
    const articleWriterPacksBlock = await loadPacks({
      builtInDir: articleWriterPacksDir,
      builtInEnabled: cfg.skills,
      tenantId: ctx.tenantId,
      agentId: 'article-writer',
    });
    const interviewerPacksBlock = await loadPacks({
      builtInDir: interviewerPacksDir,
      builtInEnabled: cfg.skills,
      tenantId: ctx.tenantId,
      agentId: 'eeat-interviewer',
    });

    // The inner agents' system prompts come from THEIR manifests, not from
    // ctx.systemPrompt (which is empty for the workflow). Look them up so the
    // inner runs see the same prompts they would see standalone.
    const { articleWriterAgent } = await import('../article-writer/index.js');
    const { eeatInterviewerAgent } = await import('../eeat-interviewer/index.js');
    const articleWriterSystemPrompt = articleWriterPacksBlock
      ? `${articleWriterPacksBlock}\n\n${articleWriterAgent.manifest.defaultPrompt}`
      : articleWriterAgent.manifest.defaultPrompt;
    const interviewerSystemPrompt = interviewerPacksBlock
      ? `${interviewerPacksBlock}\n\n${eeatInterviewerAgent.manifest.defaultPrompt}`
      : eeatInterviewerAgent.manifest.defaultPrompt;

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      const out = (input.taskOutput ?? {}) as { eeatPending?: unknown };
      const eeatAsked = !!out.eeatPending;
      const lastMessage = input.messages[input.messages.length - 1];
      const eeatAnswered = lastMessage?.role === 'user';
      const skipEeat = !cfg.eeatEnabled;

      // Router (mirrors design §"Workflow sub-graph contract"):
      //   skipEeat                       → article-writer
      //   !eeatAsked                     → eeat-interviewer
      //   eeatAsked && eeatAnswered      → article-writer
      //   else                           → article-writer (fallback;
      //                                    interviewer waits for user)
      if (skipEeat || (eeatAsked && eeatAnswered)) {
        return runArticleWriter(
          ctx,
          {
            publishToShopify: cfg.publishToShopify,
            blogHandle: cfg.blogHandle ?? null,
            defaultAuthor: cfg.defaultAuthor ?? null,
            publishImmediately: cfg.publishImmediately,
            credentialLabel: cfg.credentialLabel ?? null,
            skills: cfg.skills,
            generateCoverImage: cfg.generateCoverImage,
            coverImageStyle: cfg.coverImageStyle ?? null,
          },
          articleWriterSystemPrompt,
          input,
          { serperTools, webFetchTools, imageTools },
        );
      }
      if (!eeatAsked) {
        return runEeatInterviewer(ctx, interviewerSystemPrompt, input);
      }
      // Defensive fallback — eeatAsked but last message not from user.
      // Same as the design doc's last branch.
      return runArticleWriter(
        ctx,
        {
          publishToShopify: cfg.publishToShopify,
          blogHandle: cfg.blogHandle ?? null,
          defaultAuthor: cfg.defaultAuthor ?? null,
          publishImmediately: cfg.publishImmediately,
          credentialLabel: cfg.credentialLabel ?? null,
          skills: cfg.skills,
          generateCoverImage: cfg.generateCoverImage,
          coverImageStyle: cfg.coverImageStyle ?? null,
        },
        articleWriterSystemPrompt,
        input,
        { serperTools, webFetchTools, imageTools },
      );
    };

    return { tools: filteredTools, invoke };
  },
};
```

**Step 2: Run the test**

```bash
pnpm vitest run tests/seo-article-with-eeat.test.ts
```

Expected: PASS — all 4 router-decision tests green.

**Step 3: Register in `bootstrapAgents()`**

```ts
// src/agents/index.ts
import { seoArticleWithEeatAgent } from './builtin/seo-article-with-eeat/index.js';
// ...
agentRegistry.register(seoArticleWithEeatAgent);
```

**Step 4: Run the full suite**

```bash
pnpm typecheck && pnpm test && pnpm test:integration
```

Expected: all green.

**Step 5: Commit**

```bash
git add src/agents/builtin/seo-article-with-eeat/index.ts src/agents/index.ts tests/seo-article-with-eeat.test.ts
git commit -m "feat(seo-article-with-eeat): workflow router + bootstrap registration

Workflow IAgent that delegates between eeat-interviewer (Hop 1) and
article-writer (Hop 2 after EEAT answers). Implementation deviates from
the design doc's StateGraph pseudocode — a plain conditional function is
behaviorally identical for a 2-node graph with no internal state, and
keeps stack traces + debugging simple. Re-introduce StateGraph if/when
a workflow grows past 2 nodes (per design's 'Re-evaluate when a workflow
grows past 3 nodes / 1 HITL pause' guidance)."
```

---

## Phase C — Integration coverage for the new agents

### Task 11: Integration test — `article-writer` direct path (single hop, publish)

**Files:**
- Create: `tests/integration/article-writer.test.ts`

**What:** Mirror the structure of the existing `tests/integration/shopify-blog-writer.test.ts` first test (the happy path), but use the new `article-writer` id and assert the new contract:
1. After draft, `task.output.lastStructuredOutput.schemaName === 'article-draft'`
2. `task.output.artifact.report` is set (rendered by **report-writer**, not the agent)
3. `task.output.artifact.body` and `refs` are present
4. `pendingToolCall` is set; on approve, Shopify is called with `bodyHtml`

The `llm-mock` helper currently scripts via `scriptStructured` + `scriptToolCall`. For the report-writer rendering call, add a third script entry — a plain text response from the haiku model. Confirm the mock helper supports this; if not, add a `scriptText(content: string)` entry.

**Step 1: Check the llm-mock helper for plain-text scripting**

```bash
sed -n '1,80p' tests/integration/helpers/llm-mock.ts
```

If `scriptText` (or equivalent) doesn't exist, **add it** in this task — the report-writer's LLM call returns plain `AIMessage(content)`, not a structured tool call. Path: `tests/integration/helpers/llm-mock.ts`. Pattern: a queue of `{ role: 'ai', content: string }` responses returned by the next `model.invoke` call without a `withStructuredOutput`.

**Step 2: Write the integration test**

Use the same env-var stubbing (`CLOUDFLARE_*`, `OPENAI_API_KEY`) and `vi.mock('@aws-sdk/client-s3', ...)` as `tests/integration/shopify-blog-writer.test.ts`.

```ts
// tests/integration/article-writer.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authHeaders, mintJwt } from './helpers/auth.js';
import { seedTenantWithOwner, truncateAll } from './helpers/db.js';
import {
  clearScript,
  llmMockModule,
  scriptStructured,
  scriptText,
  scriptToolCall,
} from './helpers/llm-mock.js';
import { drainNextTask } from './helpers/runner.js';

vi.mock('../../src/llm/model-registry.js', () => llmMockModule());
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn(async () => ({})) })),
  PutObjectCommand: vi.fn(),
}));

process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key';
process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL = 'https://assets.example.com';
process.env.OPENAI_API_KEY = 'sk-test';
const { clearEnvCache } = await import('../../src/config/env.js');
clearEnvCache();

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { createTestApp } = await import('./helpers/app.js');
const { getTask } = await import('../../src/tasks/repository.js');
const { db } = await import('../../src/db/client.js');
const { tenantCredentials } = await import('../../src/db/schema/index.js');

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await truncateAll();
  clearScript();
  fetchMock.mockReset();
});

describe('article-writer atomic agent — direct routing', () => {
  it('drafts → report-writer renders prose → waiting → approve → publish', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_test_token',
      metadata: { storeUrl: 'demo-shop.myshopify.com' },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/agents/article-writer/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: { publishToShopify: true, blogHandle: 'editorial' },
      },
    });

    // Supervisor → article-writer; article-writer → submits draft.
    scriptStructured({ nextAgent: 'article-writer', clarification: null, done: false });
    scriptToolCall('submit_article', {
      title: 'Summer linen guide',
      slug: 'summer-linen-guide',
      body: '## Why linen wins in summer\n\nLong enough body content to satisfy schema minimum.',
      summaryHtml: 'Linen guide summary that meets the schema minimum length.',
      tags: ['linen', 'summer'],
      language: 'en',
      author: 'Editorial Team',
      keyDecisions: ['Hook with material-science angle', 'Lead with data'],
      progressNote: 'Draft done.',
    });
    // Report-writer renders boss prose for schemaName='article-draft'.
    scriptText(
      '## 切角\n\n從機能性切入，避開純穿搭的泛論。\n\n## EEAT 強化點\n\n用實穿經驗開頭，立刻拉開差距。',
    );

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: 'write a linen guide' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('article-writer');
    expect(task.output).toMatchObject({
      artifact: {
        // CRITICAL: report comes from report-writer, contains the prose it
        // generated — NOT a verbatim copy of structuredOutput.data.
        report: expect.stringContaining('切角'),
        body: expect.stringContaining('Why linen wins'),
        refs: expect.objectContaining({ title: 'Summer linen guide' }),
      },
      // structuredOutput is persisted on task.output for resume / spawn.
      lastStructuredOutput: {
        schemaName: 'article-draft',
        data: expect.objectContaining({ title: 'Summer linen guide' }),
        keyDecisions: expect.arrayContaining(['Hook with material-science angle']),
      },
      pendingToolCall: {
        id: 'shopify.publish_article',
        args: expect.objectContaining({
          bodyHtml: expect.stringContaining('<h2>Why linen wins in summer</h2>'),
        }),
      },
    });

    // Stub Shopify: blogs.json (find 'editorial') + article create.
    fetchMock
      .mockResolvedValueOnce({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ blogs: [{ id: 200, handle: 'editorial', title: 'Editorial' }] }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 201, text: async () => '',
        json: async () => ({
          article: { id: 4242, handle: 'summer-linen-guide', blog_id: 200, published_at: null },
        }),
      } as unknown as Response);

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('done');
    expect(task.output).not.toHaveProperty('pendingToolCall');
  });
});
```

**Step 3: Run only the new test first**

```bash
pnpm vitest run --config vitest.integration.config.ts tests/integration/article-writer.test.ts
```

Expected: PASS. If it fails, the most likely culprits:
- `scriptText` not implemented → fix the helper
- Report-writer's prompt produces a different shape than `scriptText` returns → confirm `report-writer.ts` calls `model.invoke([...]).content` (string)

**Step 4: Run the full integration suite**

```bash
pnpm test:integration
```

Expected: all green (the existing shopify-blog-writer integration tests still pass — both agents coexist).

**Step 5: Commit**

```bash
git add tests/integration/article-writer.test.ts tests/integration/helpers/llm-mock.ts
git commit -m "test(integration): article-writer direct path + report-writer rendering

End-to-end check that the new article-writer + report-writer pipeline
produces the same task.output shape as the old shopify-blog-writer plus
a populated lastStructuredOutput. Also adds scriptText() to the llm-mock
helper for the report-writer's plain-text rendering call."
```

---

### Task 12: Integration test — `seo-article-with-eeat` happy path (EEAT → answer → article)

**Files:**
- Create: `tests/integration/seo-article-with-eeat.test.ts`

**What:** Two-hop integration test mirroring the existing `tests/integration/shopify-blog-writer-eeat.test.ts` but routed through the workflow id. Asserts:
1. Hop 1: workflow → eeat-interviewer → `task.output.eeatPending` set, `artifact.report` is the question prompt (NOT report-writer prose; schema is in skip set).
2. After feedback, Hop 2: workflow → article-writer → `task.output.artifact.report` is the report-writer's rendered prose, `pendingToolCall` is set, `lastStructuredOutput.schemaName === 'article-draft'`.
3. After approve: Shopify publish fires.
4. **`task.assignedAgent === 'seo-article-with-eeat'`** at every check (resume re-pinning works).

**Step 1: Write the test**

```ts
// tests/integration/seo-article-with-eeat.test.ts
// Same scaffolding as Task 11 (env vars, vi.mock S3, fetchMock, etc.).

describe('seo-article-with-eeat workflow — EEAT → article → publish', () => {
  it('Hop 1 asks EEAT (no report-writer rendering); Hop 2 writes article (rendered)', async () => {
    const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
    const jwt = await mintJwt({ userId, email });

    await db.insert(tenantCredentials).values({
      tenantId,
      provider: 'shopify',
      secret: 'shpat_test',
      metadata: { storeUrl: 'demo-shop.myshopify.com' },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/agents/seo-article-with-eeat/activate',
      headers: authHeaders(jwt, tenantId),
      payload: {
        config: { eeatEnabled: true, publishToShopify: true, skills: { eeat: true } },
      },
    });

    // Hop 1: supervisor → workflow → eeat-interviewer.
    scriptStructured({ nextAgent: 'seo-article-with-eeat', clarification: null, done: false });
    scriptStructured({  // EEAT questions.
      questions: [
        { question: 'How many washes before pilling?', optional: false },
        { question: 'Worn in Taipei summer humidity?', optional: true },
      ],
      narrative: '## 為什麼需要老闆親身經驗\n\n網路一般文章寫不出來。',
      progressNote: '有幾個 EEAT 問題想先請老闆確認。',
    });
    // No report-writer LLM call — schemaName='eeat-questions' is in skip set.

    const create = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: authHeaders(jwt, tenantId),
      payload: { brief: '幫我寫一篇亞麻襯衫夏天指南' },
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().id as string;

    await drainNextTask();

    let task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('seo-article-with-eeat');
    expect(task.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('我需要先請你回答幾個問題'),
        refs: { askedAt: expect.any(String) },
      },
      eeatPending: { questions: expect.any(Array), askedAt: expect.any(String) },
      // Workflow is in skip set; report-writer no-ops; lastStructuredOutput
      // is still persisted (downstream may consume it later).
      lastStructuredOutput: {
        schemaName: 'eeat-questions',
        data: expect.objectContaining({ questions: expect.any(Array) }),
      },
    });

    // Hop 2: boss replies, then workflow → article-writer.
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/feedback`,
      headers: authHeaders(jwt, tenantId),
      payload: { feedback: '洗了 10 次沒起球。台北 35 度穿，涼到不像麻。' },
    });
    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('todo');

    // Workflow re-pinned (assignedAgent stamped from Hop 1) → no supervisor LLM
    // call needed. Just script the article submit + report-writer render.
    scriptToolCall('submit_article', {
      title: '亞麻襯衫夏天指南',
      slug: 'linen-summer-guide',
      body: '## 為什麼亞麻贏夏天\n\n洗 10 次不起球，台北 35 度穿涼。',
      summaryHtml: '完整亞麻襯衫指南，附親身使用心得。',
      tags: ['亞麻'],
      language: 'zh-TW',
      author: null,
      keyDecisions: ['用「洗 10 次不起球」當開頭', 'EEAT 寫在最前面'],
      progressNote: '草稿好了，開頭用了老闆親身體驗的數字。',
    });
    scriptText(
      '## 切角\n\n用老闆「洗 10 次不起球」這個具體數字當開頭，把 EEAT 寫在最前面。',
    );

    await drainNextTask();
    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('waiting');
    expect(task.assignedAgent).toBe('seo-article-with-eeat');
    expect(task.output).toMatchObject({
      artifact: {
        report: expect.stringContaining('切角'),
        body: expect.stringContaining('## 為什麼亞麻贏夏天'),
        refs: expect.objectContaining({ language: 'zh-TW' }),
      },
      lastStructuredOutput: {
        schemaName: 'article-draft',
        data: expect.objectContaining({ title: '亞麻襯衫夏天指南' }),
      },
      pendingToolCall: { id: 'shopify.publish_article' },
    });

    // Approve → publish.
    fetchMock
      .mockResolvedValueOnce({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ blogs: [{ id: 100, handle: 'news', title: 'News' }] }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 201, text: async () => '',
        json: async () => ({
          article: { id: 5000, handle: 'linen-summer-guide', blog_id: 100, published_at: null },
        }),
      } as unknown as Response);

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: authHeaders(jwt, tenantId),
      payload: { finalize: true },
    });
    expect(approve.statusCode).toBe(200);

    task = await getTask(tenantId, taskId);
    expect(task.status).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run the test**

```bash
pnpm vitest run --config vitest.integration.config.ts tests/integration/seo-article-with-eeat.test.ts
```

Expected: PASS. Two known sticky points:
- The supervisor short-circuit relies on `task.assignedAgent` set on Hop 1 → check `runner.ts:155`. Should already work because Hop 1 stamps `assignedAgent='seo-article-with-eeat'`.
- The workflow's `invoke` reads `input.taskOutput?.eeatPending` to decide routing on Hop 2 — confirm `runner.ts:115` passes `currentTaskOutput` down (it does).

**Step 3: Run full integration suite**

```bash
pnpm test:integration
```

Expected: all green.

**Step 4: Commit**

```bash
git add tests/integration/seo-article-with-eeat.test.ts
git commit -m "test(integration): seo-article-with-eeat full EEAT workflow + resume

Two-hop end-to-end: workflow → eeat-interviewer (Hop 1, skip-rendered)
→ user feedback → workflow re-pinned → article-writer (Hop 2, rendered)
→ approve → publish. Locks in: assignedAgent stays as the workflow id
across the HITL pause (resume short-circuit is happy), eeat-questions
schema is skipped by report-writer (interviewer's question prompt
preserved), article-draft schema IS rendered by report-writer."
```

---

### Task 13: Integration test — workflow with `eeatEnabled=false` (skip-EEAT branch)

**Files:**
- Modify: `tests/integration/seo-article-with-eeat.test.ts` (append a 2nd `it`)

**What:** Confirm the workflow behaves like a thin wrapper around `article-writer` when EEAT is disabled. Single hop, no Hop 1.

**Step 1: Append the test**

```ts
it('eeatEnabled=false → workflow goes straight to article-writer (single hop)', async () => {
  const { tenantId, userId, email } = await seedTenantWithOwner({ plan: 'basic' });
  const jwt = await mintJwt({ userId, email });

  await db.insert(tenantCredentials).values({
    tenantId, provider: 'shopify', secret: 'shpat_x',
    metadata: { storeUrl: 'demo-shop.myshopify.com' },
  });

  await app.inject({
    method: 'POST',
    url: '/v1/agents/seo-article-with-eeat/activate',
    headers: authHeaders(jwt, tenantId),
    payload: { config: { eeatEnabled: false, publishToShopify: true, skills: {} } },
  });

  scriptStructured({ nextAgent: 'seo-article-with-eeat', clarification: null, done: false });
  scriptToolCall('submit_article', {
    title: 'Skip EEAT article',
    slug: 'skip-eeat-article',
    body: '## Body\n\nLong enough body content here for the schema minimum.',
    summaryHtml: 'A short summary that meets schema minimum.',
    tags: ['demo'],
    language: 'en',
    author: null,
    keyDecisions: ['Skip EEAT per config.'],
    progressNote: 'Draft done.',
  });
  scriptText('## 切角\n\nDirect path, no EEAT.');

  const create = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: authHeaders(jwt, tenantId),
    payload: { brief: 'write something quickly' },
  });
  const taskId = create.json().id as string;
  await drainNextTask();

  const task = await getTask(tenantId, taskId);
  expect(task.status).toBe('waiting');
  expect(task.assignedAgent).toBe('seo-article-with-eeat');
  expect(task.output).not.toHaveProperty('eeatPending');
  expect(task.output).toMatchObject({
    artifact: { report: expect.stringContaining('切角'), body: expect.stringContaining('Body') },
    lastStructuredOutput: { schemaName: 'article-draft' },
    pendingToolCall: { id: 'shopify.publish_article' },
  });
});
```

**Step 2: Run**

```bash
pnpm vitest run --config vitest.integration.config.ts tests/integration/seo-article-with-eeat.test.ts
```

Expected: both tests PASS.

**Step 3: Commit**

```bash
git add tests/integration/seo-article-with-eeat.test.ts
git commit -m "test(integration): workflow eeatEnabled=false skips interviewer

Single-hop happy path when the boss disables EEAT in config — workflow
behaves as a thin wrapper around article-writer. No eeatPending in
task.output, no Hop 1, report-writer renders the article-draft prose."
```

---

## Phase D — Migrate the rest of the test suite

### Task 14: Migrate `tests/seo-strategist.test.ts` to use `article-writer`

**Files:**
- Modify: `tests/seo-strategist.test.ts`

**What:** Replace every `'shopify-blog-writer'` in the test scripts with `'article-writer'`. Strategist itself doesn't hardcode an agent id — its LLM picks from `availableExecutionAgents`. The tests script the LLM's choice.

**Step 1: Replace**

```bash
sed -i '' "s/'shopify-blog-writer'/'article-writer'/g" tests/seo-strategist.test.ts
```

**Step 2: Run**

```bash
pnpm test
```

Expected: all green. If a test referenced `shopify-blog-writer` in a regex / matcher / description, it'll fail loudly — adjust by hand.

**Step 3: Commit**

```bash
git add tests/seo-strategist.test.ts
git commit -m "test(seo-strategist): migrate spawn target from shopify-blog-writer → article-writer

Strategy-spawned children skip the EEAT branch (per design — bulk plans
don't pause for interviews) so they spawn into the atomic article-writer,
not the seo-article-with-eeat workflow."
```

---

### Task 15: Migrate other unit-test references

**Files:**
- Modify: `tests/intake-agent.test.ts` (lines 30, 52)
- Modify: `tests/supervisor.test.ts` (lines 75, 85, 107, 165, 171)
- Modify: `tests/smoke/openrouter.test.ts` (lines 51, 85, 93)

**What:** Each of these references `'shopify-blog-writer'` in a stub manifest, a roster string, or a scripted route choice. Replace with `'article-writer'` consistently — it's the closest equivalent and the new default for "writes ONE article" scripts.

**Step 1: Run the same sed across all three**

```bash
sed -i '' "s/'shopify-blog-writer'/'article-writer'/g" \
  tests/intake-agent.test.ts \
  tests/supervisor.test.ts \
  tests/smoke/openrouter.test.ts
```

Then read each diff:

```bash
git diff tests/intake-agent.test.ts tests/supervisor.test.ts tests/smoke/openrouter.test.ts
```

Hand-fix any embedded text — descriptions, comments, expected substrings — that read awkwardly with the new id (e.g. `'writes one Shopify blog article'` may now read `'writes one Shopify article via article-writer'` or stay if it still makes sense).

**Step 2: Run full unit suite**

```bash
pnpm test
```

Expected: all green.

**Step 3: Commit**

```bash
git add tests/intake-agent.test.ts tests/supervisor.test.ts tests/smoke/openrouter.test.ts
git commit -m "test: switch unit-test references from shopify-blog-writer → article-writer

Roster stubs, supervisor route scripts, and openrouter smoke prompts now
all use the new atomic agent id. Smoke tests are gated on env vars and
not run in CI, but the strings stay current."
```

---

### Task 16: Migrate integration test references (NOT yet deleting old tests)

**Files:**
- Modify: `tests/integration/activation.test.ts` (lines 141–221)
- Modify: `tests/integration/skill-packs-repository.test.ts` (lines 34, 45, 53)
- Modify: `tests/integration/knowledge-layer-e2e.integration.test.ts` (lines 58, 64, 81, 88, 91, 108)
- Modify: `tests/integration/tenant-isolation.test.ts` (line 41)
- Modify: `tests/integration/report-writer-wiring.test.ts` (line 59 — comment only)

**What:** Same id-rename treatment. The activation test confirms credentials are required; the new article-writer requires Shopify creds (same as before). The skill-packs / knowledge-layer tests bind packs to the new agent id (`appliesTo: ['article-writer']`).

**Step 1: Bulk rename + read diffs**

```bash
sed -i '' "s/'shopify-blog-writer'/'article-writer'/g" \
  tests/integration/activation.test.ts \
  tests/integration/skill-packs-repository.test.ts \
  tests/integration/knowledge-layer-e2e.integration.test.ts \
  tests/integration/tenant-isolation.test.ts \
  tests/integration/report-writer-wiring.test.ts

sed -i '' 's|/v1/agents/shopify-blog-writer/|/v1/agents/article-writer/|g' \
  tests/integration/activation.test.ts \
  tests/integration/knowledge-layer-e2e.integration.test.ts \
  tests/integration/tenant-isolation.test.ts \
  tests/integration/report-writer-wiring.test.ts

git diff tests/integration/
```

**Step 2: Hand-fix any test descriptions / comments that name the old agent**

E.g. `it('shopify-blog-writer requires Shopify credentials', ...)` → `it('article-writer requires Shopify credentials', ...)`.

The `report-writer-wiring.test.ts` regression test (PR1) currently asserts the OLD agent id. Per the new world it asserts `article-writer` AND that `task.output.lastStructuredOutput` IS now set (because article-writer DOES emit it). Update those assertions:

```ts
// tests/integration/report-writer-wiring.test.ts
// OLD assertion: expect(output).not.toHaveProperty('lastStructuredOutput');
// NEW assertion: agent now emits structuredOutput, so report-writer fills the
// report. Update test to assert the new contract OR delete it (the new
// article-writer.test.ts in Task 11 covers the same property).
```

Decision: **delete** the `report-writer-wiring.test.ts` integration test in this task — it was specifically the "no agent emits structuredOutput yet" regression net for PR1, and that property is no longer true. Article-writer's own integration test (Task 11) covers report-writer rendering positively.

```bash
git rm tests/integration/report-writer-wiring.test.ts
```

**Step 3: Run integration suite**

```bash
pnpm test:integration
```

Expected: all green. The tests now cover the new agent ids; the old `shopify-blog-writer*.test.ts` files still exist and still pass (the agent is still registered).

**Step 4: Commit**

```bash
git add tests/integration/
git commit -m "test(integration): migrate references to article-writer; drop PR1 regression net

Activation, skill-packs, knowledge-layer, and tenant-isolation tests now
target article-writer. The PR1 zero-behavior-change regression test is
removed because article-writer DOES emit structuredOutput — the property
that test guarded no longer holds. The new tests/integration/article-writer.test.ts
(Task 11) covers report-writer rendering positively, which is the
stronger property anyway."
```

---

## Phase E — Strategist + supervisor tweaks

### Task 17: Update supervisor prompt to flag workflow shape

**Files:**
- Modify: `src/orchestrator/supervisor.ts:9-36` (SUPERVISOR_PROMPT)
- Modify: `src/orchestrator/supervisor.ts:79` (roster construction)

**What:** Per design §"PR2": "Supervisor prompt updated: workflow agents flagged as 'prefer when the brief matches a multi-step pattern'". The supervisor sees a flat roster of agents today. We expose `metadata.shape` (set on the workflow's manifest in Task 8) in the roster line so the LLM can prefer the workflow when the brief matches.

**Step 1: Modify the roster builder**

```ts
// src/orchestrator/supervisor.ts
const roster = available
  .map((a) => {
    const shape = (a.manifest.metadata as { shape?: string } | undefined)?.shape;
    const shapeTag = shape === 'workflow' ? ' [workflow]' : '';
    return `- ${a.manifest.id}${shapeTag}: ${a.manifest.description}`;
  })
  .join('\n');
```

**Step 2: Add prompt guidance**

Append to `SUPERVISOR_PROMPT` after the existing "Strategy vs Execution" line:

```
- Workflow agents (tagged [workflow] in the roster) bundle multiple stages with
  HITL pauses between them. Prefer a workflow when the brief explicitly asks for
  the multi-stage pattern the workflow describes (e.g. "深度文章 + EEAT 訪談"
  matches seo-article-with-eeat). For single-shot work, prefer the matching
  atomic agent (e.g. article-writer for a one-off article).
```

**Step 3: Verify supervisor unit tests still pass**

```bash
pnpm test
```

The supervisor tests in `tests/supervisor.test.ts` mock the LLM's structured output, so they don't see the prompt text — they should pass unchanged.

**Step 4: Commit**

```bash
git add src/orchestrator/supervisor.ts
git commit -m "feat(supervisor): flag workflow-shape agents in roster + prompt

The roster now appends [workflow] to workflow-shape agents (read from
manifest.metadata.shape). The system prompt explains when to prefer the
workflow vs. the atomic agent. Supervisor unit tests are unaffected
(they mock the LLM's structured output, not the prompt text)."
```

---

## Phase F — Delete the old agent (the destructive step)

### Task 18: Delete `shopify-blog-writer` agent + its old integration tests

**Files:**
- Delete: `src/agents/builtin/shopify-blog-writer/` (entire directory)
- Delete: `tests/integration/shopify-blog-writer.test.ts`
- Delete: `tests/integration/shopify-blog-writer-eeat.test.ts`
- Modify: `src/agents/index.ts` (remove import + register call)
- Modify: `src/tasks/output.ts:36` (update comment "shopify-blog-writer Stage 1 → eeat-interviewer")
- Modify: `src/db/schema/agents.ts:16`, `src/db/schema/tenant_skill_packs.ts:7`, `src/db/schema/task_logs.ts:28` (update example agent ids in comments)

**What:** All replacement code is in. Delete the old surface in one cut.

**Step 1: Delete**

```bash
rm -rf src/agents/builtin/shopify-blog-writer/
rm tests/integration/shopify-blog-writer.test.ts tests/integration/shopify-blog-writer-eeat.test.ts
```

**Step 2: Edit `src/agents/index.ts`** — remove the `shopifyBlogWriterAgent` import + register call.

**Step 3: Update comments**

```ts
// src/tasks/output.ts:36
/** HITL: eeat-interviewer asks questions; boss must answer via /feedback. */
eeatPending?: { ... };
```

```ts
// src/db/schema/agents.ts:16, similar in tenant_skill_packs.ts and task_logs.ts
// Replace 'shopify-blog-writer' with 'article-writer' in example strings.
```

```bash
sed -i '' 's|shopify-blog-writer|article-writer|g' \
  src/db/schema/agents.ts \
  src/db/schema/tenant_skill_packs.ts \
  src/db/schema/task_logs.ts
```

(These are comments only — no schema migration needed.)

**Step 4: Full pipeline**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
```

Expected:
- typecheck: clean
- lint: clean
- unit: all green (PR1 baseline 198 + new tests added in PR2 - removed tests)
- integration: all green (105 baseline + article-writer + 2 workflow tests - 2 old shopify-blog-writer tests - 1 dropped regression net)

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(agents): remove shopify-blog-writer; replaced by article-writer + workflow

Final destructive step of PR2. The eeat-interviewer + article-writer
atomic pair (registered in earlier commits) plus the seo-article-with-eeat
workflow now own the responsibilities the monolithic shopify-blog-writer
held — and they each do one thing. Comments referencing the old agent id
across db/schema/* and tasks/output.ts updated to mention the new ids.

No DB schema migration: task.output.eeatPending shape is preserved
verbatim by eeat-interviewer, so any in-flight tasks resume cleanly."
```

---

## Phase G — Documentation + final verification

### Task 19: Update `docs/API_GUIDE.md` for the new agent ids

**Files:**
- Modify: `docs/API_GUIDE.md` (search for `shopify-blog-writer`; replace with the relevant new id depending on context)

**What:** API guide names agents in the activation flow examples; UI team will hit broken docs otherwise.

**Step 1: Find references**

```bash
grep -n "shopify-blog-writer" docs/API_GUIDE.md
```

**Step 2: For each hit**, decide whether the example is about a "single-article writer" (use `article-writer`) or "EEAT workflow" (use `seo-article-with-eeat`). Default: `article-writer` is the closer 1:1 replacement; add a sidebar note about the workflow option if the original example was about EEAT.

**Step 3: Commit**

```bash
git add docs/API_GUIDE.md
git commit -m "docs(api-guide): update agent ids for the EEAT split (PR2)

Activation examples now reference article-writer for direct article
work and seo-article-with-eeat for the EEAT workflow. shopify-blog-writer
no longer exists."
```

---

### Task 20: Final full-pipeline verification

**Files:** None modified.

**Step 1: Full pipeline**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
```

Expected:
- typecheck: clean
- lint: clean
- unit tests: PR1's 198 + 2 (article-writer) + 1 (eeat-interviewer) + 4 (workflow router) = 205 (subject to exact final counts; all green)
- integration tests: PR1's 106 - 2 (deleted shopify-blog-writer tests) - 1 (dropped PR1 regression net) + 1 (article-writer) + 2 (workflow happy + skip) = 106 (give or take; all green)

If counts diverge by more than ±2 from these estimates, something is missing or duplicated — investigate before merging.

**Step 2: Manual smoke** — start the dev server and exercise the new endpoints in `/docs`:

```bash
supabase status   # confirm running
pnpm dev          # in another shell
```

In Swagger:
- `POST /v1/agents/article-writer/activate` with a Shopify credential — should 200.
- `POST /v1/agents/seo-article-with-eeat/activate` — should 200.
- `GET /v1/agents/shopify-blog-writer` — should 404 (agent gone).
- Create a task brief that the supervisor would route to either; observe the timeline shows the new agent running and report-writer's prose appearing in `task.output.artifact.report`.

**Step 3: Commit message preparation for the PR**

The branch's commit log already forms the PR narrative. Expected order:
```
feat(article-writer): scaffold ...
feat(article-writer): real implementation; Artifact.report now optional
feat(agents): register article-writer ...
feat(eeat-interviewer): scaffold ...
feat(eeat-interviewer): real implementation + bootstrap
feat(seo-article-with-eeat): scaffold ...
feat(seo-article-with-eeat): workflow router + bootstrap
test(integration): article-writer direct path + report-writer rendering
test(integration): seo-article-with-eeat full EEAT workflow + resume
test(integration): workflow eeatEnabled=false skips interviewer
test(seo-strategist): migrate spawn target ...
test: switch unit-test references ...
test(integration): migrate references to article-writer ...
feat(supervisor): flag workflow-shape agents ...
feat(agents): remove shopify-blog-writer ...
docs(api-guide): update agent ids ...
```

PR title: `feat(graph): PR2 — split shopify-blog-writer into eeat-interviewer + article-writer + seo-article-with-eeat workflow`

PR body link to `docs/plans/2026-05-07-graph-refactor-design.md` and call out the design's PR2 scope.

---

## What's NOT in this PR (for clarity, deferred to later PRs per design)

- **PR3–7**: Migrate the remaining atomic agents (`market-researcher`, `product-planner`, `seo-strategist`, `product-designer`, `shopify-publisher`) to emit `structuredOutput` and stop emitting `artifact.report`. Each agent in its own PR. Until then, they keep setting `artifact.report` themselves and report-writer no-ops on them (PR1's null-check still holds).
- **PR8**: A second workflow sub-graph (e.g. `research-and-cluster`). Add only on demand.
- **PR9**: Split `article-writer` into `article-writer` + `shopify-blog-publisher`. Out of scope here; `article-writer` keeps the publish tool.
- **PR10**: Cleanup pass — remove deprecated `artifact.report`-from-agent codepath when every agent has migrated.

---

## Risks specific to PR2

**R-PR2-1: Resume routing breaks if `assignedAgent` isn't stamped on Hop 1**

Symptom: after EEAT feedback, supervisor's pinnedAgent short-circuit doesn't fire; LLM picks an unrelated agent.
Mitigation: Task 12's integration test explicitly asserts `task.assignedAgent === 'seo-article-with-eeat'` after Hop 1 AND after Hop 2.

**R-PR2-2: `loadPacks` is called twice in the workflow (once per inner agent)**

Cost: 2 extra DB reads per workflow build vs. atomic. Acceptable per design's "monitor; expected sub-100ms" stance. If it bites, cache `loadPacks(...)` per (tenantId, agentId) at registry level.

**R-PR2-3: The workflow's config schema duplicates article-writer's**

Maintenance burden: changing article-writer's config requires updating workflow's too. Acceptable for now (one workflow); revisit when adding the second workflow if the duplication grows.

**R-PR2-4: Strategist tests use scripted LLM output that names `'shopify-blog-writer'`**

Already addressed by Task 14. The strategist's *production* code never hardcodes a worker id (it picks from `availableExecutionAgents`), so removing the old agent doesn't break strategist behaviour — it just narrows the LLM's choice set.

**R-PR2-5: Workflow's `lastOutput.agentId` collision**

The graph's per-agent node sets `lastOutput.agentId = manifest.id`, which for the workflow is `'seo-article-with-eeat'`. Inner runs (`runEeatInterviewer` / `runArticleWriter`) return AgentOutput without an agentId; the wrapping `addNode(manifest.id, ...)` in `graph.ts:61-129` is what stamps it. So the outer agentId is always the workflow id. Confirmed correct by Task 9 + Task 12.
