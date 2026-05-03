import { Marked } from 'marked';

/**
 * Convert agent-emitted markdown body into HTML for downstream consumers
 * (Shopify Admin API, etc). One conversion at the publish boundary; agents
 * never touch HTML directly.
 *
 * Async-renderer support is disabled (`async: false`) so callers can stay
 * synchronous. GFM is on for tables and task lists.
 *
 * NOTE: this helper does NOT sanitize. Agent output is LLM-generated, so
 * `<script>`, `<iframe>`, etc. would pass through verbatim. Sanitization,
 * if needed, is the responsibility of the publisher (Shopify tool wrappers).
 * Today Shopify Admin API rejects unsafe tags server-side; if we ever
 * publish to a less strict surface we must add DOMPurify at that boundary.
 *
 * Uses a private `Marked` instance (not the package-level singleton) so we
 * don't mutate global state — any future caller that imports `marked`
 * directly gets default options, not ours.
 */
const renderer = new Marked({ async: false, gfm: true, breaks: false });

export function markdownToHtml(md: string): string {
  const out = renderer.parse(md);
  if (typeof out !== 'string') {
    throw new Error('markdownToHtml: marked returned a Promise — async option mis-set');
  }
  return out;
}
