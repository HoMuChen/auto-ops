import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentTool } from '../../agents/types.js';
import { ShopifyAdminClient } from './client.js';

/**
 * Shopify tools exposed to the Ops Assistant agent.
 *
 * Tools that mutate Shopify state are tagged `requiresApproval: true` so the
 * orchestrator routes the task to a Waiting (HITL) gate before invocation.
 */
export async function buildShopifyTools(tenantId: string): Promise<AgentTool[]> {
  const createProduct = tool(
    async (input: { title: string; bodyHtml?: string; tags?: string[]; vendor?: string }) => {
      const client = await ShopifyAdminClient.forTenant(tenantId);
      const result = await client.createProduct({
        title: input.title,
        body_html: input.bodyHtml,
        tags: input.tags,
        vendor: input.vendor,
      });
      return JSON.stringify(result);
    },
    {
      name: 'shopify_create_product',
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
      const client = await ShopifyAdminClient.forTenant(tenantId);
      const result = await client.updateProduct(input.productId, input.patch);
      return JSON.stringify(result);
    },
    {
      name: 'shopify_update_product',
      description: 'Update fields on an existing Shopify product. Requires approval.',
      schema: z.object({
        productId: z.number(),
        patch: z.record(z.unknown()),
      }),
    },
  );

  return [
    { id: 'shopify.create_product', tool: createProduct, requiresApproval: true },
    { id: 'shopify.update_product', tool: updateProduct, requiresApproval: true },
  ];
}
