import { z } from 'zod';

export const SerperSearchResultSchema = z.object({
  organic: z.array(
    z.object({ title: z.string(), url: z.string(), snippet: z.string(), position: z.number() }),
  ),
  peopleAlsoAsk: z.array(z.string()),
  relatedSearches: z.array(z.string()),
  knowledgeGraph: z.unknown().optional(),
  answerBox: z.unknown().optional(),
});

export type SerperSearchResult = z.infer<typeof SerperSearchResultSchema>;

export interface SerperSearchInput {
  query: string;
  locale?: string;
  num?: number;
}

export class SerperClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: { apiKey: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async search(input: SerperSearchInput): Promise<SerperSearchResult> {
    const body: Record<string, unknown> = { q: input.query, num: input.num ?? 10 };
    if (input.locale) body.gl = input.locale.split('-')[0]?.toLowerCase();
    const res = await this.fetchImpl('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': this.opts.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Serper ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      organic?: { title: string; link: string; snippet: string; position: number }[];
      peopleAlsoAsk?: { question: string }[];
      relatedSearches?: { query: string }[];
      knowledgeGraph?: unknown;
      answerBox?: unknown;
    };
    return SerperSearchResultSchema.parse({
      organic: (json.organic ?? []).map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        position: r.position,
      })),
      peopleAlsoAsk: (json.peopleAlsoAsk ?? []).map((p) => p.question),
      relatedSearches: (json.relatedSearches ?? []).map((r) => r.query),
      ...(json.knowledgeGraph ? { knowledgeGraph: json.knowledgeGraph } : {}),
      ...(json.answerBox ? { answerBox: json.answerBox } : {}),
    });
  }
}
