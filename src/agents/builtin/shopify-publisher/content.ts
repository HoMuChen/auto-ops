/**
 * Platform-agnostic product content produced by product-designer and consumed by
 * publisher agents. Mirrors the artifact shape: report (boss-facing markdown
 * narrative), body (markdown product description), refs (machine-readable
 * fields the publisher needs).
 */
export interface ProductContent {
  /** zh-TW Markdown report — boss-facing narrative. Forwarded into the
   *  publisher's artifact.report and shown on the kanban / artifact panel. */
  report: string;
  /** Product description body in Markdown. Converted to HTML at the publish
   *  boundary by the publisher (markdownToHtml). */
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
