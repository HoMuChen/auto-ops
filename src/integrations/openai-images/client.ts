import { Blob } from 'node:buffer';

export interface OpenAIImagesClientOpts {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class OpenAIImagesClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAIImagesClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async generate(opts: {
    prompt: string;
    size?: '1024x1024' | '1792x1024' | '1024x1792';
    quality?: 'low' | 'medium' | 'high' | 'auto';
  }): Promise<Buffer> {
    const res = await this.fetchImpl('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: opts.prompt,
        n: 1,
        size: opts.size ?? '1024x1024',
        quality: opts.quality ?? 'medium',
        // gpt-image-2 always returns b64_json by default; response_format is not accepted
      }),
    });
    return this.parseImageResponse(res);
  }

  async edit(opts: {
    imageBuffer: Buffer;
    prompt: string;
    size?: '1024x1024';
  }): Promise<Buffer> {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append(
      'image',
      new Blob([opts.imageBuffer], { type: 'image/png' }) as unknown as File,
      'image.png',
    );
    form.append('prompt', opts.prompt);
    form.append('n', '1');
    form.append('size', opts.size ?? '1024x1024');

    const res = await this.fetchImpl('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form as unknown as NonNullable<Parameters<typeof fetch>[1]>['body'],
    });
    return this.parseImageResponse(res);
  }

  private async parseImageResponse(res: Response): Promise<Buffer> {
    const json = (await res.json()) as {
      data?: { b64_json?: string }[];
      error?: { message: string };
    };
    if (!res.ok || !json.data?.[0]?.b64_json) {
      throw new Error(json.error?.message ?? `OpenAI Images error (${res.status})`);
    }
    return Buffer.from(json.data[0].b64_json, 'base64');
  }
}
