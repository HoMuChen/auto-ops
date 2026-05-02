/**
 * Smoke test — requires real credentials in .env.
 * Run manually: pnpm test -- tests/smoke/cloudflare-r2.test.ts
 *
 * What it checks:
 *   1. Upload a small PNG buffer to R2
 *   2. Assert the returned URL is publicly accessible (HTTP 200)
 *   3. Clean up the uploaded object
 */
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { CloudflareImagesClient } from '../../src/integrations/cloudflare/images-client.js';

const REQUIRED = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_R2_BUCKET',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_PUBLIC_BASE_URL',
] as const;

describe.skipIf(REQUIRED.some((k) => !env[k]))('Cloudflare R2 smoke test', () => {
  it('uploads a file and serves it publicly', async () => {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID!;
    const bucket = env.CLOUDFLARE_R2_BUCKET!;
    const accessKeyId = env.CLOUDFLARE_R2_ACCESS_KEY_ID!;
    const secretAccessKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!;
    const publicBaseUrl = env.CLOUDFLARE_R2_PUBLIC_BASE_URL!;

    const client = new CloudflareImagesClient({
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket,
      publicBaseUrl,
    });

    // Minimal 1×1 white PNG
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );

    const { cfImageId, url } = await client.upload(pngBuffer, {
      filename: 'smoke-test.png',
      mimeType: 'image/png',
      metadata: { purpose: 'smoke-test' },
    });

    console.log('Uploaded:', url);
    expect(url).toMatch(/^https:\/\//);
    expect(cfImageId).toBeTruthy();

    // Verify the URL is publicly reachable
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image');

    // Clean up
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cfImageId }));
    console.log('Cleaned up:', cfImageId);
  }, 30_000);
});
