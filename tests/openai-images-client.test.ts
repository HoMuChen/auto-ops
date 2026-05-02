import { describe, expect, it, vi } from 'vitest';
import { OpenAIImagesClient } from '../src/integrations/openai-images/client.js';

const fakeImageB64 = Buffer.from('fakeimage').toString('base64');

describe('OpenAIImagesClient', () => {
  it('generate: POSTs to OpenAI and returns Buffer', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: fakeImageB64 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new OpenAIImagesClient({ apiKey: 'sk-test', fetchImpl: fakeFetch as unknown as typeof fetch });
    const buf = await client.generate({ prompt: 'a linen shirt' });

    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
        body: expect.stringContaining('"model":"gpt-image-1"'),
      }),
    );
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString('base64')).toBe(fakeImageB64);
  });

  it('edit: sends multipart and returns Buffer', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: fakeImageB64 }] }),
        { status: 200 },
      ),
    );
    const client = new OpenAIImagesClient({ apiKey: 'sk-test', fetchImpl: fakeFetch as unknown as typeof fetch });
    const buf = await client.edit({
      imageBuffer: Buffer.from('srcimg'),
      prompt: 'white background',
    });
    expect(buf.toString('base64')).toBe(fakeImageB64);
    const [, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    // multipart body, not JSON
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('throws on non-2xx', async () => {
    const fakeFetch = vi.fn(async () => new Response('{"error":{"message":"invalid key"}}', { status: 401 }));
    const client = new OpenAIImagesClient({ apiKey: 'bad', fetchImpl: fakeFetch as unknown as typeof fetch });
    await expect(client.generate({ prompt: 'x' })).rejects.toThrow(/invalid key/);
  });
});
