import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentTool } from '../../agents/types.js';
import type { SerpCache } from './cache.js';

export const SERPER_TOOL_IDS = ['serper.search'] as const;

export interface BuildSerperToolsOptions {
  tenantId: string;
  cache: SerpCache;
}

export function buildSerperTools(opts: BuildSerperToolsOptions): AgentTool[] {
  const searchTool = tool(
    async (input: { query: string; locale?: string; num?: number }) => {
      return opts.cache.search(opts.tenantId, {
        query: input.query,
        ...(input.locale ? { locale: input.locale } : {}),
        num: input.num ?? 10,
      });
    },
    {
      name: 'serper_search',
      description:
        'Search Google via Serper. Returns top organic results, People Also Ask questions, ' +
        'and related searches. Use this for SEO keyword research and competitor SERP analysis.',
      schema: z.object({
        query: z.string().min(2).describe('The search query (a specific keyword phrase).'),
        locale: z.string().nullish().describe('Optional locale, e.g. "en", "zh-tw".'),
        num: z
          .number()
          .int()
          .min(1)
          .max(20)
          .nullish()
          .describe('Number of organic results, default 10.'),
      }),
    },
  );
  return [{ id: 'serper.search', tool: searchTool }];
}
