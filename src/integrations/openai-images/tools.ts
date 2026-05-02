import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentTool } from '../../agents/types.js';
import type { CloudflareImagesClient } from '../cloudflare/images-client.js';
import type { NewTenantImage, TenantImage } from '../../db/schema/index.js';
import type { OpenAIImagesClient } from './client.js';

export const IMAGE_TOOL_IDS = ['images.generate', 'images.edit'] as const;

export interface BuildImageToolsOpts {
  openaiClient: OpenAIImagesClient;
  cfClient: CloudflareImagesClient;
  insertImage: (input: Omit<NewTenantImage, 'id' | 'createdAt'>) => Promise<TenantImage>;
  getImageById?: (tenantId: string, id: string) => Promise<TenantImage | null>;
  fetchImageBuffer?: (url: string) => Promise<Buffer>;
  taskId?: string;
}

export function buildImageTools(
  tenantId: string,
  opts: BuildImageToolsOpts,
): AgentTool[] {
  const generateTool = tool(
    async (input: { prompt: string; size?: string; quality?: string }) => {
      const buffer = await opts.openaiClient.generate({
        prompt: input.prompt,
        size: (input.size as '1024x1024') ?? '1024x1024',
        quality: (input.quality as 'standard') ?? 'standard',
      });
      const { cfImageId, url } = await opts.cfClient.upload(buffer, {
        filename: 'generated.png',
        mimeType: 'image/png',
      });
      const image = await opts.insertImage({
        tenantId,
        cfImageId,
        url,
        sourceType: 'generated',
        prompt: input.prompt,
        status: 'ready',
        mimeType: 'image/png',
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
      });
      return { id: image.id, url: image.url };
    },
    {
      name: 'images_generate',
      description: 'Generate a new image from a text prompt using AI. Returns the image id and url.',
      schema: z.object({
        prompt: z.string().min(5).describe('Detailed description of the image to generate.'),
        size: z.enum(['1024x1024', '1792x1024', '1024x1792']).optional(),
        quality: z.enum(['standard', 'hd']).optional(),
      }),
    },
  );

  const editTool = tool(
    async (input: { sourceImageId: string; prompt: string }) => {
      if (!opts.getImageById || !opts.fetchImageBuffer) {
        throw new Error('images.edit requires getImageById and fetchImageBuffer');
      }
      const source = await opts.getImageById(tenantId, input.sourceImageId);
      if (!source) throw new Error(`Source image ${input.sourceImageId} not found`);

      const sourceBuffer = await opts.fetchImageBuffer(source.url);
      const buffer = await opts.openaiClient.edit({
        imageBuffer: sourceBuffer,
        prompt: input.prompt,
      });
      const { cfImageId, url } = await opts.cfClient.upload(buffer, {
        filename: 'edited.png',
        mimeType: 'image/png',
      });
      const image = await opts.insertImage({
        tenantId,
        cfImageId,
        url,
        sourceType: 'edited',
        prompt: input.prompt,
        sourceImageId: input.sourceImageId,
        status: 'ready',
        mimeType: 'image/png',
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
      });
      return { id: image.id, url: image.url };
    },
    {
      name: 'images_edit',
      description: 'Edit an existing image using AI. Provide the source image id and a description of the edit.',
      schema: z.object({
        sourceImageId: z.string().describe('ID of the existing tenant image to edit.'),
        prompt: z.string().min(5).describe('Description of how to edit the image.'),
      }),
    },
  );

  return [
    { id: 'images.generate', tool: generateTool },
    { id: 'images.edit', tool: editTool },
  ];
}
