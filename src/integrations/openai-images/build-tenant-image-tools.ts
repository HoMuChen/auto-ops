import type { AgentTool } from '../../agents/types.js';
import { env } from '../../config/env.js';
import { CloudflareImagesClient } from '../cloudflare/images-client.js';
import { getImageById, insertImage } from '../cloudflare/images-repository.js';
import { OpenAIImagesClient } from './client.js';
import { buildImageTools } from './tools.js';

interface BuildTenantImageToolsArgs {
  tenantId: string;
  taskId: string;
  /** Tenant's image style suffix — appended verbatim to every prompt. Empty / undefined → no-op. */
  styleSuffix?: string | undefined;
  /** Set true for agents that need `images.edit` (download source → edit → upload). */
  enableEdit?: boolean;
}

/**
 * Wires the OpenAI image-gen tools to the tenant's R2/Cloudflare bucket and
 * returns them. Returns `[]` when any required env var is missing — agents
 * silently degrade to text-only.
 *
 * Single source of truth for the env wiring + style-suffix plumbing. Was
 * duplicated across product-designer and article-writer before.
 */
export function buildTenantImageTools({
  tenantId,
  taskId,
  styleSuffix,
  enableEdit = false,
}: BuildTenantImageToolsArgs): AgentTool[] {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const r2AccessKey = env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const r2SecretKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const r2Bucket = env.CLOUDFLARE_R2_BUCKET;
  const r2PublicBaseUrl = env.CLOUDFLARE_R2_PUBLIC_BASE_URL;
  const openaiKey = env.OPENAI_API_KEY;

  if (!accountId || !r2AccessKey || !r2SecretKey || !r2Bucket || !r2PublicBaseUrl || !openaiKey) {
    return [];
  }

  return buildImageTools(tenantId, {
    openaiClient: new OpenAIImagesClient({ apiKey: openaiKey }),
    cfClient: new CloudflareImagesClient({
      accountId,
      accessKeyId: r2AccessKey,
      secretAccessKey: r2SecretKey,
      bucket: r2Bucket,
      publicBaseUrl: r2PublicBaseUrl,
    }),
    insertImage,
    taskId,
    ...(styleSuffix ? { styleSuffix } : {}),
    ...(enableEdit
      ? {
          getImageById,
          fetchImageBuffer: async (url: string) =>
            Buffer.from(await (await fetch(url)).arrayBuffer()),
        }
      : {}),
  });
}
