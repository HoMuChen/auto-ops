import { describe, expect, it, vi } from 'vitest';
import { CloudflareImagesClient } from '../src/integrations/cloudflare/images-client.js';

const BASE_OPTS = {
  accountId: 'acct',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  bucket: 'test-bucket',
  publicBaseUrl: 'https://assets.example.com',
};

describe('CloudflareImagesClient', () => {
  it('uploads buffer via injected putObject and returns key + url', async () => {
    const putObject = vi.fn(async () => {});
    const client = new CloudflareImagesClient({ ...BASE_OPTS, putObject });

    const result = await client.upload(Buffer.from('imgdata'), {
      filename: 'product.jpg',
      mimeType: 'image/jpeg',
    });

    expect(putObject).toHaveBeenCalledTimes(1);
    const call = putObject.mock.calls[0];
    const [key, body, mimeType] = call as unknown as [string, Buffer, string];
    expect(key).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(body.toString()).toBe('imgdata');
    expect(mimeType).toBe('image/jpeg');
    expect(result.cfImageId).toBe(key);
    expect(result.url).toBe(`https://assets.example.com/${key}`);
  });

  it('strips trailing slash from publicBaseUrl', async () => {
    const putObject = vi.fn(async () => {});
    const client = new CloudflareImagesClient({
      ...BASE_OPTS,
      publicBaseUrl: 'https://assets.example.com/',
      putObject,
    });
    const result = await client.upload(Buffer.from('x'), {
      filename: 'x.png',
      mimeType: 'image/png',
    });
    // URL should not have double slash between domain and path
    expect(result.url).not.toMatch(/example\.com\/\//);
    expect(result.url).toMatch(/^https:\/\/assets\.example\.com\/[^/]/);
  });

  it('propagates putObject errors', async () => {
    const putObject = vi.fn(async () => {
      throw new Error('R2 quota exceeded');
    });
    const client = new CloudflareImagesClient({ ...BASE_OPTS, putObject });
    await expect(
      client.upload(Buffer.from('x'), { filename: 'x.jpg', mimeType: 'image/jpeg' }),
    ).rejects.toThrow(/R2 quota exceeded/);
  });
});
