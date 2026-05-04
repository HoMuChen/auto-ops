import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentTool } from '../../agents/types.js';
import type { WebFetchClient } from './client.js';

export const WEB_FETCH_TOOL_IDS = ['web.fetch'] as const;

export interface BuildWebFetchToolsOptions {
  client: WebFetchClient;
}

export function buildWebFetchTools(opts: BuildWebFetchToolsOptions): AgentTool[] {
  const fetchTool = tool(
    async (input: { url: string; maxChars?: number }) => {
      return opts.client.fetch({
        url: input.url,
        ...(input.maxChars ? { maxChars: input.maxChars } : {}),
      });
    },
    {
      name: 'web_fetch',
      description:
        'Fetch a single URL and return its main text content (chrome stripped). ' +
        'Use AFTER serper_search when a snippet is not enough — pick 2-3 most relevant ' +
        'organic URLs and fetch their full content. Avoid fetching every result; ' +
        'each fetch costs latency and tokens. Returns title, plain text, and a truncated flag.',
      schema: z.object({
        url: z.string().url().describe('Absolute http(s) URL to fetch.'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(20_000)
          .nullish()
          .describe('Hard cap on returned characters; default 8000.'),
      }),
    },
  );
  return [{ id: 'web.fetch', tool: fetchTool }];
}
