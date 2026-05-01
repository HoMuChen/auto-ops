import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { SHOPIFY_TOOL_IDS, buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { buildModel } from '../../../llm/model-registry.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';

const DEFAULT_PROMPT = `You are an Operations Assistant for a Shopify store.
Your job: read a brief about a product and produce a polished listing draft —
title, body (HTML), tags, vendor — ready for the human to review and approve.
You do NOT call any tool yourself. The framework will call shopify.create_product
on your behalf only after the user explicitly approves the draft via the HITL gate.

Hard rules:
- Never invent SKUs, prices, or stock counts; mention only what the brief includes.
- Body must be safe, well-formed HTML (use <p>, <ul>/<li>, <h3>; no <script>/<style>).
- Tags: 3–8 short lower-case keywords, comma-free.
- Default vendor and language come from the agent config; honour them unless the
  brief explicitly overrides.
- Use the tenant's default language (see config) for the listing copy.

Return strictly the structured object requested.`;

/**
 * User-facing activation config. The frontend renders this as a form (via
 * zod-to-json-schema → JSON Schema) when the tenant "hires" this agent.
 */
const configSchema = z.object({
  shopify: z
    .object({
      credentialLabel: z
        .string()
        .nullish()
        .describe('Which Shopify connection to use when multiple are bound'),
      defaultVendor: z
        .string()
        .nullish()
        .describe('Vendor name applied when the AI does not infer one'),
      autoPublish: z
        .boolean()
        .default(false)
        .describe('If true, products are created as Active; otherwise Draft'),
    })
    .default({}),
  defaultLanguage: z
    .enum(['zh-TW', 'en', 'ja'])
    .default('zh-TW')
    .describe('Primary language used in product listings'),
});

type ShopifyOpsConfig = z.infer<typeof configSchema>;

/**
 * Structured product listing the LLM produces. Maps directly onto Shopify's
 * Admin REST `POST /products` body (after the framework adds `status`).
 */
const ListingSchema = z.object({
  title: z.string().min(1).max(255).describe('Product title shown on the storefront.'),
  bodyHtml: z
    .string()
    .min(1)
    .describe('Product description as HTML. Use <p>, <ul>/<li>, <h3>; never <script>/<style>.'),
  tags: z.array(z.string().min(1)).min(1).max(20).describe('Short keyword tags. 3–8 is ideal.'),
  vendor: z.string().min(1).describe('Brand/vendor for the product.'),
  productType: z
    .string()
    .optional()
    .describe('Optional Shopify product type (category) — keep blank if unsure.'),
});

type ProductListing = z.infer<typeof ListingSchema>;

export const shopifyOpsAgent: IAgent = {
  manifest: {
    id: 'shopify-ops',
    name: 'AI Shopify Ops Assistant',
    description: 'Prepares Shopify product listings and pushes them to the store.',
    // Sonnet is fast + cheap + strong at structured output — well-suited to
    // turning a brief into a tidy product listing.
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
    defaultPrompt: DEFAULT_PROMPT,

    toolIds: SHOPIFY_TOOL_IDS,

    requiredCredentials: [
      {
        provider: 'shopify',
        description: 'Shopify Admin API token + store URL — needed to create products',
        setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
      },
    ],

    configSchema,
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ShopifyOpsConfig;
    const model = buildModel(ctx.modelConfig).withStructuredOutput(ListingSchema, {
      name: 'shopify_product_listing',
    });
    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.shopify.credentialLabel ? { credentialLabel: cfg.shopify.credentialLabel } : {}),
      ...(cfg.shopify.defaultVendor ? { defaultVendor: cfg.shopify.defaultVendor } : {}),
      autoPublish: cfg.shopify.autoPublish,
    });

    const filteredTools = ctx.toolWhitelist
      ? tools.filter((t) => ctx.toolWhitelist?.includes(t.id))
      : tools;

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', '商品資料我來整理一下', {
        language: cfg.defaultLanguage,
        autoPublish: cfg.shopify.autoPublish,
      });

      const constraints = [
        `Tenant default vendor: ${cfg.shopify.defaultVendor ?? '(none — must infer or use brief)'}`,
        `Tenant default language: ${cfg.defaultLanguage}`,
        `Auto-publish on creation: ${cfg.shopify.autoPublish} (informational — the listing is created as draft/active by the framework, not by you)`,
      ];

      const systemMessage = `${ctx.systemPrompt}

Tenant constraints:
- ${constraints.join('\n- ')}`;

      const messages = [
        new SystemMessage(systemMessage),
        ...input.messages.map((m) =>
          m.role === 'user' ? new HumanMessage(m.content) : new HumanMessage(m.content),
        ),
      ];

      const listing = (await model.invoke(messages)) as ProductListing;

      // Args mirror the LangChain tool schema in shopify/tools.ts:
      // { title, bodyHtml, tags, vendor }. The tool resolves credentials and
      // applies status=active|draft from agent config inside its closure.
      const pendingToolCall = {
        id: 'shopify.create_product',
        args: {
          title: listing.title,
          bodyHtml: listing.bodyHtml,
          tags: listing.tags,
          vendor: listing.vendor,
        },
      };

      const preview = renderListingMarkdown(listing, cfg.shopify.autoPublish);

      await ctx.emitLog(
        'agent.listing.ready',
        `商品 listing 準備好：「${listing.title}」，老闆確認 OK 我就上架`,
        {
          toolsAvailable: filteredTools.map((t) => t.id),
          pendingTool: pendingToolCall.id,
        },
      );

      return {
        message: preview,
        awaitingApproval: true,
        payload: { listing, language: cfg.defaultLanguage },
        pendingToolCall,
      };
    };

    return { tools: filteredTools, invoke };
  },
};

function renderListingMarkdown(listing: ProductListing, autoPublish: boolean): string {
  return [
    `# ${listing.title}`,
    '',
    `**Vendor:** ${listing.vendor}${
      listing.productType ? ` · **Type:** ${listing.productType}` : ''
    }`,
    `**Tags:** ${listing.tags.join(', ')}`,
    `**On approve:** create product as \`${autoPublish ? 'active' : 'draft'}\` in Shopify`,
    '',
    '---',
    '',
    listing.bodyHtml,
    '',
    '_Approve to push this to Shopify; Feedback to ask for revisions._',
  ].join('\n');
}
