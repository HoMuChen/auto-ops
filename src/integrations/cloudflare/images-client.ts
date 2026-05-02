import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface CloudflareImagesClientOpts {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Public base URL for delivered objects, e.g. https://assets.example.com */
  publicBaseUrl: string;
  /**
   * Injectable uploader — replaces the real S3 PUT for unit tests.
   * Receives (key, buffer, mimeType) and must resolve when the upload succeeds.
   */
  putObject?: (key: string, body: Buffer, mimeType: string) => Promise<void>;
}

/**
 * Uploads images to Cloudflare R2 via the S3-compatible API.
 *
 * The `cfImageId` returned is the R2 object key (a UUID). The `url` is
 * `${publicBaseUrl}/${key}` — snapshotted into tenant_images.url at upload
 * time, so changing CLOUDFLARE_R2_PUBLIC_BASE_URL only affects future uploads.
 */
export class CloudflareImagesClient {
  private readonly uploader: (key: string, body: Buffer, mimeType: string) => Promise<void>;

  constructor(private readonly opts: CloudflareImagesClientOpts) {
    if (opts.putObject) {
      this.uploader = opts.putObject;
    } else {
      const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
        },
      });
      this.uploader = async (key, body, mimeType) => {
        await s3.send(
          new PutObjectCommand({
            Bucket: opts.bucket,
            Key: key,
            Body: body,
            ContentType: mimeType,
          }),
        );
      };
    }
  }

  async upload(
    buffer: Buffer,
    meta: { filename: string; mimeType: string; metadata?: Record<string, string> },
  ): Promise<{ cfImageId: string; url: string }> {
    const ext = meta.filename.includes('.') ? `.${meta.filename.split('.').pop()}` : '';
    const key = `${randomUUID()}${ext}`;
    await this.uploader(key, buffer, meta.mimeType);
    const url = `${this.opts.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    return { cfImageId: key, url };
  }
}
