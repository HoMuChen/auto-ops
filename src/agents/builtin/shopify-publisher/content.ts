/**
 * Platform-agnostic product content produced by product-designer and consumed by
 * publisher agents. Mirrors the artifact shape: body (markdown product
 * description) + refs (machine-readable fields the publisher needs).
 *
 * The boss-facing prose is rendered by the shared report-writer node from
 * the publisher's own structuredOutput; ProductContent intentionally does
 * not carry it.
 */
export interface ProductContent {
  /** Product description body in Markdown — image-free. Converted to HTML at
   *  the publish boundary by the publisher (markdownToHtml). Image markdown
   *  is rebuilt by display callers from refs.imageUrls. */
  body: string;
  refs: {
    title: string;
    tags: string[];
    vendor: string;
    productType?: string;
    language: string;
    /** CF Images public URLs — already uploaded, ready for platform APIs. */
    imageUrls: string[];
  };
  /** First-person progress note shown on the kanban timeline. Not part of
   *  the artifact wire format — used as the spawn child's initial message
   *  and the parent's emitLog message. */
  progressNote: string;
}
