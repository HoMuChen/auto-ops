/**
 * Platform-agnostic product content produced by product-planner/product-designer and
 * consumed by all publisher agents (shopify-publisher, future woocommerce-publisher, etc.).
 *
 * This is the contract between content generation and platform publishing.
 * Changing any field requires updating all publishers that read it.
 */
export interface ProductContent {
  title: string;
  bodyHtml: string;
  tags: string[];
  vendor: string;
  productType?: string;
  language: string;
  /** CF Images public URLs — already uploaded, ready for platform APIs. */
  imageUrls: string[];
  /** First-person progress note shown on the kanban timeline. */
  progressNote: string;
}
