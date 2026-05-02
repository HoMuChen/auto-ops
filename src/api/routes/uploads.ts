import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { CloudflareImagesClient } from '../../integrations/cloudflare/images-client.js';
import { insertImage } from '../../integrations/cloudflare/images-repository.js';
import { ValidationError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, tenantOf } from '../middleware/tenant.js';
import { ErrorEnvelope } from '../schemas.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.post(
    '/uploads',
    {
      schema: {
        tags: ['uploads'],
        // @fastify/multipart handles request parsing outside the Zod type-provider
        // pipeline, so we omit `body` here and document the multipart schema via
        // the OpenAPI YAML directly (docs/openapi.yaml). Only the response is
        // defined here so fastify-swagger can generate the 200 schema correctly.
        response: {
          200: z.object({
            id: z.string().uuid().describe('Image UUID — pass as imageIds entry in task/intake requests'),
            url: z.string().url().describe('Cloudflare R2 public delivery URL'),
          }),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
        },
      },
    },
    async (req) => {
    const tenantId = tenantOf(req);

    const data = await req.file({ limits: { fileSize: MAX_BYTES } });
    if (!data) throw new ValidationError('No file uploaded', {});

    const mimeType = data.mimetype;
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new ValidationError(
        `Unsupported MIME type: ${mimeType}. Allowed: jpeg, png, webp, gif`,
        {},
      );
    }

    const buffer = await data.toBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      throw new ValidationError('File exceeds 10 MB limit', {});
    }

    // Pass env vars as-is; CloudflareImagesClient throws at upload time if misconfigured.
    // This allows the constructor to be mocked in tests without needing real env vars.
    const cf = new CloudflareImagesClient({
      accountId: env.CLOUDFLARE_ACCOUNT_ID ?? '',
      accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ?? '',
      bucket: env.CLOUDFLARE_R2_BUCKET ?? '',
      publicBaseUrl: env.CLOUDFLARE_R2_PUBLIC_BASE_URL ?? 'https://unconfigured.invalid',
    });
    const { cfImageId, url } = await cf.upload(buffer, {
      filename: data.filename ?? 'upload',
      mimeType,
      metadata: { tenantId },
    });

    const image = await insertImage({
      tenantId,
      cfImageId,
      url,
      sourceType: 'uploaded',
      status: 'ready',
      mimeType,
      fileSize: buffer.byteLength,
    });

    return { id: image.id, url: image.url };
  },
  );
}
