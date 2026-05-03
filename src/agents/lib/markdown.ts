import { marked } from 'marked';

/**
 * Convert agent-emitted markdown body into HTML for downstream consumers
 * (Shopify Admin API, etc). One conversion at the publish boundary; agents
 * never touch HTML directly.
 *
 * Async-renderer support is disabled (`async: false`) so callers can stay
 * synchronous. GFM is on for tables and task lists.
 */
marked.setOptions({ async: false, gfm: true, breaks: false });

export function markdownToHtml(md: string): string {
  if (!md) return '';
  return marked.parse(md) as string;
}
