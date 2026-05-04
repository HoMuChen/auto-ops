import { z } from 'zod';
import { extractText } from './extractor.js';

export const WebFetchResultSchema = z.object({
  url: z.string().url(),
  finalUrl: z.string().url(),
  status: z.number(),
  title: z.string().optional(),
  text: z.string(),
  truncated: z.boolean(),
});

export type WebFetchResult = z.infer<typeof WebFetchResultSchema>;

export interface WebFetchInput {
  url: string;
  maxChars?: number;
}

export interface WebFetchClientOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms; default 10s. */
  timeoutMs?: number;
  /** Default char cap; default 8000. */
  defaultMaxChars?: number;
  /** Hard cap regardless of caller input. Default 20000. */
  hardMaxChars?: number;
  /** User-Agent header value. */
  userAgent?: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (compatible; auto-ops-research/0.1; +https://github.com/HoMuChen/auto-ops)';

export class WebFetchClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly defaultMaxChars: number;
  private readonly hardMaxChars: number;
  private readonly userAgent: string;

  constructor(opts: WebFetchClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.defaultMaxChars = opts.defaultMaxChars ?? 8000;
    this.hardMaxChars = opts.hardMaxChars ?? 20_000;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
  }

  async fetch(input: WebFetchInput): Promise<WebFetchResult> {
    const cap = Math.min(input.maxChars ?? this.defaultMaxChars, this.hardMaxChars);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(input.url, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`web.fetch ${res.status} for ${input.url}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      throw new Error(`web.fetch non-HTML content (${contentType || 'unknown'}) for ${input.url}`);
    }

    const html = await res.text();
    const extracted = extractText(html);
    const truncated = extracted.text.length > cap;
    const text = truncated ? extracted.text.slice(0, cap) : extracted.text;

    return WebFetchResultSchema.parse({
      url: input.url,
      finalUrl: res.url || input.url,
      status: res.status,
      ...(extracted.title ? { title: extracted.title } : {}),
      text,
      truncated,
    });
  }
}
