/**
 * Task artifacts — the typed deliverables produced by agents.
 *
 * We're migrating from a discriminated union (`LegacyArtifact`, kept here
 * during the refactor) to a flat shape (`Artifact`):
 *
 *   {
 *     report: string,             // markdown narrative — primary surface
 *     body?: string,              // markdown deliverable — only for content agents
 *     refs?: Record<string, unknown>,  // structured contract for IDs/URLs/scheduling
 *   }
 *
 * Inter-agent handoff is markdown; structured fields exist only where they
 * absolutely must (machine reading by tools, spawn routing, idempotency stamps).
 *
 * See docs/plans/2026-05-04-markdown-first-artifacts-design.md for rationale.
 */

export interface Artifact {
  /** Canonical narrative (markdown). Audience: humans + downstream agents. */
  report: string;
  /** Deliverable content (markdown). Only present when an agent produces
   *  publishable content (article body, product description). Converted to
   *  HTML at the publish boundary via `markdownToHtml`. */
  body?: string;
  /** Structured contract: IDs, URLs, scheduling, routing, publish stamps.
   *  Free-form bag — keys agreed between producing agent and any consumer
   *  (publisher, tool-executor). Frontend ignores it apart from a small
   *  details panel. */
  refs?: Record<string, unknown>;
}

// ----- LEGACY (will be removed in Task 10) -----

export interface BlogArticleData {
  title: string;
  bodyHtml: string;
  summaryHtml: string;
  summary?: string;
  tags: string[];
  language: string;
  author?: string;
}

export interface BlogPublishedMeta {
  articleId: number;
  blogId: number;
  blogHandle: string;
  handle: string;
  articleUrl: string;
  publishedAt: string | null;
  status: 'published' | 'draft';
}

export interface ProductContentData {
  title: string;
  bodyHtml: string;
  summary?: string;
  tags: string[];
  vendor: string;
  productType?: string;
  language: string;
  imageUrls: string[];
}

export interface ProductPublishedMeta {
  productId: number;
  handle: string;
  adminUrl: string;
  status: 'active' | 'draft';
}

export interface SeoPlanTopic {
  title: string;
  primaryKeyword: string;
  language: string;
  writerBrief: string;
  assignedAgent: string;
  scheduledAt?: string;
  searchIntent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  paaQuestions: string[];
  relatedSearches: string[];
  competitorTopAngles: string[];
  competitorGaps: string[];
  targetWordCount: number;
  eeatHook: string;
}

export interface SeoPlanData {
  summary: string;
  topics: SeoPlanTopic[];
}

export interface ProductPlanVariant {
  title: string;
  platform?: string;
  language: string;
  marketingAngle: string;
  keyMessages: string[];
  copyBrief: {
    tone: string;
    featuresToHighlight: string[];
    forbiddenClaims: string[];
  };
  imagePlan: {
    purpose: string;
    styleHint: string;
    priority: 'required' | 'optional';
  }[];
  assignedAgent: 'product-designer';
  scheduledAt?: string;
}

export interface ProductPlanData {
  summary: string;
  variants: ProductPlanVariant[];
}

export interface EeatQuestion {
  question: string;
  hint?: string;
  optional?: boolean;
}

export interface EeatQuestionsData {
  summary?: string;
  questions: EeatQuestion[];
  askedAt: string;
}

export interface ClarificationData {
  question: string;
}

export type LegacyArtifact =
  | { kind: 'blog-article'; data: BlogArticleData; published?: BlogPublishedMeta }
  | { kind: 'product-content'; data: ProductContentData; published?: ProductPublishedMeta }
  | { kind: 'seo-plan'; data: SeoPlanData }
  | { kind: 'product-plan'; data: ProductPlanData }
  | { kind: 'eeat-questions'; data: EeatQuestionsData }
  | { kind: 'clarification'; data: ClarificationData };

export type LegacyArtifactKind = LegacyArtifact['kind'];
