import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { CloudflareImagesClient } from '../../integrations/cloudflare/images-client.js';
import { insertImage } from '../../integrations/cloudflare/images-repository.js';
import { ValidationError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, tenantOf } from '../middleware/tenant.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.post('/uploads', { schema: { tags: ['uploads'] } }, async (req) => {
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

    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const token = env.CLOUDFLARE_IMAGES_TOKEN;
    const accountHash = env.CLOUDFLARE_IMAGES_HASH;
    if (!accountId || !token || !accountHash) {
      throw new Error('Cloudflare Images is not configured (missing env vars)');
    }

    const cf = new CloudflareImagesClient({ accountId, token, accountHash });
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
  });
}
