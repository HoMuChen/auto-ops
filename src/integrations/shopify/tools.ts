import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentTool } from '../../agents/types.js';
import { ShopifyAdminClient } from './client.js';

export interface ShopifyToolOptions {
  /** `tenant_credentials.label` selector when the tenant has multiple stores. */
  credentialLabel?: string;
  /** Default vendor applied when the AI does not supply one for a product. */
  defaultVendor?: string;
  /**
   * If true, products are created in `active` status (visible immediately);
   * otherwise `draft`. Most users want `false` (draft + manual review) until
   * they trust the agent.
   */
  autoPublish?: boolean;
  /**
   * Blog selector for `shopify.publish_article`. If `blogHandle` is given the
   * tool finds the blog by handle (e.g. "news"); otherwise it falls back to
   * the first blog returned by the store. Most Shopify stores have a single
   * "news" blog created at install time.
   */
  blogHandle?: string;
  /** Default author byline applied when the AI does not supply one. */
  defaultAuthor?: string;
  /**
   * If true, articles are published immediately (visible on the storefront).
   * Default false — create as draft so the user can review on Shopify before
   * exposing.
   */
  publishArticleImmediately?: boolean;
}

/**
 * Shopify tools exposed to the Ops Assistant agent.
 *
 * Tools that mutate Shopify state are tagged `requiresApproval: true` so the
 * orchestrator routes the task to a Waiting (HITL) gate before invocation.
 *
 * Tool *definitions* are static (id, schema, description). Tool *instances* are
 * built per (tenant, agent activation) so credentials and config are bound at
 * the right scope — see src/agents/builtin/shopify-ops/index.ts.
 */
export async function buildShopifyTools(
  tenantId: string,
  options: ShopifyToolOptions = {},
): Promise<AgentTool[]> {
  const {
    credentialLabel,
    defaultVendor,
    autoPublish,
    blogHandle,
    defaultAuthor,
    publishArticleImmediately,
  } = options;

  const createProduct = tool(
    async (input: { title: string; bodyHtml?: string; tags?: string[]; vendor?: string }) => {
      const client = await ShopifyAdminClient.forTenant(tenantId, credentialLabel);
      const result = await client.createProduct({
        title: input.title,
        body_html: input.bodyHtml,
        tags: input.tags,
        vendor: input.vendor ?? defaultVendor,
        status: autoPublish ? 'active' : 'draft',
      });
      // Returning the raw object lets the post-approval executor stash
      // structured fields (productId, handle, adminUrl) on task.output without
      // re-parsing JSON.
      const product = result.product;
      return {
        productId: product.id,
        handle: product.handle,
        adminUrl: `https://${client.storeDomain}/admin/products/${product.id}`,
        status: autoPublish ? 'active' : 'draft',
      };
    },
    {
      name: 'shopify.create_product',
      description: 'Create a new Shopify product. Requires approval before execution.',
      schema: z.object({
        title: z.string(),
        bodyHtml: z.string().optional(),
        tags: z.array(z.string()).optional(),
        vendor: z.string().optional(),
      }),
    },
  );

  const updateProduct = tool(
    async (input: { productId: number; patch: Record<string, unknown> }) => {
      const client = await ShopifyAdminClient.forTenant(tenantId, credentialLabel);
      const result = await client.updateProduct(input.productId, input.patch);
      const product = result.product;
      return {
        productId: product.id,
        handle: product.handle,
        adminUrl: `https://${client.storeDomain}/admin/products/${product.id}`,
      };
    },
    {
      name: 'shopify.update_product',
      description: 'Update fields on an existing Shopify product. Requires approval.',
      schema: z.object({
        productId: z.number(),
        patch: z.record(z.unknown()),
      }),
    },
  );

  const publishArticle = tool(
    async (input: {
      title: string;
      bodyHtml: string;
      summaryHtml?: string;
      tags?: string[];
      author?: string;
    }) => {
      const client = await ShopifyAdminClient.forTenant(tenantId, credentialLabel);

      // Resolve which blog to publish to. Most stores have one "news" blog;
      // multi-blog stores can pin a specific one via agent config.
      const { blogs } = await client.listBlogs();
      if (blogs.length === 0) {
        throw new Error(
          'Shopify store has no blogs — create one in Online Store → Blog Posts before publishing.',
        );
      }
      const targetBlog = blogHandle ? blogs.find((b) => b.handle === blogHandle) : blogs[0];
      if (!targetBlog) {
        throw new Error(
          `No Shopify blog with handle "${blogHandle}". Available: ${blogs
            .map((b) => b.handle)
            .join(', ')}`,
        );
      }

      const { article } = await client.createArticle(targetBlog.id, {
        title: input.title,
        body_html: input.bodyHtml,
        ...(input.summaryHtml ? { summary_html: input.summaryHtml } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        author: input.author ?? defaultAuthor ?? 'Auto-Ops',
        published: publishArticleImmediately ?? false,
      });

      return {
        articleId: article.id,
        blogId: targetBlog.id,
        blogHandle: targetBlog.handle,
        handle: article.handle,
        articleUrl: `https://${client.storeDomain}/admin/articles/${article.id}`,
        publishedAt: article.published_at,
        status: publishArticleImmediately ? 'published' : 'draft',
      };
    },
    {
      name: 'shopify.publish_article',
      description:
        'Publish a blog article to a Shopify blog. Requires HITL approval before execution.',
      schema: z.object({
        title: z.string(),
        bodyHtml: z.string(),
        summaryHtml: z.string().optional(),
        tags: z.array(z.string()).optional(),
        author: z.string().optional(),
      }),
    },
  );

  return [
    { id: 'shopify.create_product', tool: createProduct, requiresApproval: true },
    { id: 'shopify.update_product', tool: updateProduct, requiresApproval: true },
    { id: 'shopify.publish_article', tool: publishArticle, requiresApproval: true },
  ];
}

/** Static tool ids exposed by this integration — for manifest declarations. */
export const SHOPIFY_TOOL_IDS = [
  'shopify.create_product',
  'shopify.update_product',
  'shopify.publish_article',
] as const;
