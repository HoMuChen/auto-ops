import { describe, expect, it, vi } from 'vitest';
import { CloudflareImagesClient } from '../src/integrations/cloudflare/images-client.js';

describe('CloudflareImagesClient', () => {
  it('uploads buffer and parses cfImageId + url from response', async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              id: 'cf-img-123',
              variants: ['https://imagedelivery.net/HASH/cf-img-123/public'],
            },
            success: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new CloudflareImagesClient({
      accountId: 'acct',
      token: 'tok',
      accountHash: 'HASH',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const result = await client.upload(Buffer.from('imgdata'), {
      filename: 'product.jpg',
      mimeType: 'image/jpeg',
    });
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acct/images/v1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
    expect(result.cfImageId).toBe('cf-img-123');
    expect(result.url).toBe('https://imagedelivery.net/HASH/cf-img-123/public');
  });

  it('throws on CF API error', async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: 'quota exceeded' }] }), {
          status: 400,
        }),
    );
    const client = new CloudflareImagesClient({
      accountId: 'a',
      token: 't',
      accountHash: 'h',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(
      client.upload(Buffer.from('x'), { filename: 'x.jpg', mimeType: 'image/jpeg' }),
    ).rejects.toThrow(/quota exceeded/);
  });
});
