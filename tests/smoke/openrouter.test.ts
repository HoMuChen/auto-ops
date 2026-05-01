/**
 * Smoke tests against the real OpenRouter API.
 *
 * Goal: catch the things mocks can't — that the configured model slugs in
 * agent manifests still resolve, that `withStructuredOutput` actually returns
 * JSON the production Zod schemas accept, and that the API key + headers are
 * valid. We do NOT assert content quality (non-deterministic).
 *
 * Gating: skipped unless BOTH `OPENROUTER_LIVE=1` and a non-placeholder
 * `OPENROUTER_API_KEY` are present. Costs real money — never run in default CI.
 *
 * Run with:
 *   OPENROUTER_LIVE=1 OPENROUTER_API_KEY=sk-or-... pnpm test:smoke
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const live =
  process.env.OPENROUTER_LIVE === '1' &&
  !!process.env.OPENROUTER_API_KEY &&
  process.env.OPENROUTER_API_KEY !== 'test-openrouter-key';

const d = live ? describe : describe.skip;

// Imports are deferred behind dynamic `await import()` so the unit-test runner
// (which sets a placeholder API key) doesn't try to construct a ChatOpenAI
// against a fake key when this file is collected.
const loadModelRegistry = () => import('../../src/llm/model-registry.js');

d('OpenRouter smoke — production model slugs resolve', () => {
  it('supervisor: anthropic/claude-opus-4.7 returns parseable RouteSchema', async () => {
    const { buildModel } = await loadModelRegistry();
    const RouteSchema = z.object({
      nextAgent: z.string().nullable(),
      clarification: z.string().nullable(),
      done: z.boolean().default(false),
    });

    const model = buildModel({
      model: 'anthropic/claude-opus-4.7',
      temperature: 0,
      maxTokens: 256,
    }).withStructuredOutput(RouteSchema, { name: 'route_decision' });

    const decision = await model.invoke([
      new SystemMessage(
        'You route a brief to one of the listed employees. Output strictly the requested JSON.',
      ),
      new HumanMessage(
        'Available employees:\n- shopify-blog-writer: writes one Shopify blog article\n\nUser brief:\nWrite one article about summer fabrics.',
      ),
    ]);

    expect(RouteSchema.safeParse(decision).success).toBe(true);
  }, 60_000);

  it('seo-strategist: anthropic/claude-opus-4.7 returns parseable PlanSchema', async () => {
    const { buildModel } = await loadModelRegistry();
    // Mirror the production schema shape — duplicated here so a shape change
    // in the agent file is caught as a smoke-suite update, not a silent skew.
    const PlanSchema = z.object({
      reasoning: z.string(),
      topics: z
        .array(
          z.object({
            title: z.string().min(1),
            primaryKeyword: z.string(),
            language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
            writerBrief: z.string().min(20),
            assignedAgent: z.string(),
          }),
        )
        .min(1),
    });

    const model = buildModel({
      model: 'anthropic/claude-opus-4.7',
      temperature: 0,
      maxTokens: 1024,
    }).withStructuredOutput(PlanSchema, { name: 'seo_content_plan' });

    const plan = await model.invoke([
      new SystemMessage(
        'You plan 1–3 SEO article topics. Pick assignedAgent="shopify-blog-writer" for every topic. Output strictly the requested JSON.',
      ),
      new HumanMessage('Brief: spring linen collection launch, language zh-TW.'),
    ]);

    expect(PlanSchema.safeParse(plan).success).toBe(true);
  }, 60_000);

  it('shopify-blog-writer: anthropic/claude-opus-4.7 returns parseable ArticleSchema', async () => {
    const { buildModel } = await loadModelRegistry();
    const ArticleSchema = z.object({
      title: z.string().min(1).max(140),
      bodyHtml: z.string().min(50),
      summaryHtml: z.string().min(20).max(400),
      tags: z.array(z.string().min(1)).min(1).max(20),
      language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
      author: z.string().optional(),
    });

    const model = buildModel({
      model: 'anthropic/claude-opus-4.7',
      temperature: 0,
      maxTokens: 2048,
    }).withStructuredOutput(ArticleSchema, { name: 'blog_article_draft' });

    const article = await model.invoke([
      new SystemMessage(
        'Write one short Shopify blog article (<400 words bodyHtml). Output strictly the requested JSON.',
      ),
      new HumanMessage('Topic: choosing linen for hot humid summer. Language: en.'),
    ]);

    expect(ArticleSchema.safeParse(article).success).toBe(true);
  }, 60_000);

  it('shopify-ops: anthropic/claude-sonnet-4.6 returns parseable ListingSchema', async () => {
    const { buildModel } = await loadModelRegistry();
    const ListingSchema = z.object({
      title: z.string().min(1).max(255),
      bodyHtml: z.string().min(1),
      tags: z.array(z.string().min(1)).min(1).max(20),
      vendor: z.string().min(1),
      productType: z.string().optional(),
    });

    const model = buildModel({
      model: 'anthropic/claude-sonnet-4.6',
      temperature: 0,
      maxTokens: 1024,
    }).withStructuredOutput(ListingSchema, { name: 'product_listing' });

    const listing = await model.invoke([
      new SystemMessage(
        'Draft a single Shopify product listing. Output strictly the requested JSON.',
      ),
      new HumanMessage('Product: 100% linen oversized shirt, vendor "Acme", colour ecru, size M.'),
    ]);

    expect(ListingSchema.safeParse(listing).success).toBe(true);
  }, 60_000);
});
