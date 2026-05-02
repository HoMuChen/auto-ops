import { Blob } from 'node:buffer';

export interface CloudflareImagesClientOpts {
  accountId: string;
  token: string;
  /** CF Images delivery hash — appears in variant URLs. */
  accountHash: string;
  fetchImpl?: typeof fetch;
}

export class CloudflareImagesClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CloudflareImagesClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async upload(
    buffer: Buffer,
    meta: { filename: string; mimeType: string; metadata?: Record<string, string> },
  ): Promise<{ cfImageId: string; url: string }> {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: meta.mimeType }), meta.filename);
    if (meta.metadata) {
      form.append('metadata', JSON.stringify(meta.metadata));
    }

    const res = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${this.opts.accountId}/images/v1`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.token}` },
        body: form as unknown as BodyInit,
      },
    );

    const json = (await res.json()) as {
      success: boolean;
      errors?: { message: string }[];
      result?: { id: string; variants: string[] };
    };

    if (!json.success || !json.result) {
      const msg = json.errors?.[0]?.message ?? `CF Images upload failed (${res.status})`;
      throw new Error(msg);
    }

    const cfImageId = json.result.id;
    const url = `https://imagedelivery.net/${this.opts.accountHash}/${cfImageId}/public`;
    return { cfImageId, url };
  }
}
