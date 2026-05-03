/**
 * Task artifacts — the typed deliverables produced by agents.
 *
 * Tasks have three orthogonal surfaces:
 *   - logs:     timeline of execution events (what happened, when)
 *   - messages: conversation thread (short progressNotes + user feedback)
 *   - output.artifact: the actual deliverable, typed as a discriminated union
 *
 * UI dispatches on `artifact.kind` and renders one component per kind. This
 * keeps the frontend independent of agent internals — every agent that
 * produces an article emits `kind: 'blog-article'` regardless of who wrote it.
 *
 * Flow-control fields (pendingToolCall, spawnTasks, eeatPending) live on
 * task.output directly — they're not artifacts.
 */

export interface BlogArticleData {
  title: string;
  bodyHtml: string;
  summaryHtml: string;
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
  reasoning: string;
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
  reasoning: string;
  summary: string;
  variants: ProductPlanVariant[];
}

export interface EeatQuestion {
  question: string;
  hint?: string;
  optional?: boolean;
}

export interface EeatQuestionsData {
  questions: EeatQuestion[];
  askedAt: string;
}

export interface ClarificationData {
  question: string;
}

export type Artifact =
  | { kind: 'blog-article'; data: BlogArticleData; published?: BlogPublishedMeta }
  | { kind: 'product-content'; data: ProductContentData; published?: ProductPublishedMeta }
  | { kind: 'seo-plan'; data: SeoPlanData }
  | { kind: 'product-plan'; data: ProductPlanData }
  | { kind: 'eeat-questions'; data: EeatQuestionsData }
  | { kind: 'clarification'; data: ClarificationData };

export type ArtifactKind = Artifact['kind'];
