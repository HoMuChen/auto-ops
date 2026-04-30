import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, type StateGraphArgs } from '@langchain/langgraph';

/**
 * GraphState — the shared state passed between Supervisor and Worker nodes.
 *
 * Persisted by the LangGraph Postgres checkpointer keyed by `taskId` (thread_id).
 * Resuming a task = loading the latest checkpoint with the same thread_id.
 */
export const GraphStateAnnotation = Annotation.Root({
  /** Stable identifiers carried with the run. */
  tenantId: Annotation<string>(),
  taskId: Annotation<string>(),

  /** Conversation thread visible to all nodes. */
  messages: Annotation<BaseMessage[]>({
    reducer: (curr, next) => curr.concat(next),
    default: () => [],
  }),

  /** Free-form params extracted from the user's brief. */
  params: Annotation<Record<string, unknown>>({
    reducer: (_curr, next) => next,
    default: () => ({}),
  }),

  /** The agent the Supervisor has chosen for the next step. */
  nextAgent: Annotation<string | null>({
    reducer: (_curr, next) => next,
    default: () => null,
  }),

  /** Latest output from a worker node, surfaced to the kanban card. */
  lastOutput: Annotation<{
    agentId: string;
    message: string;
    payload?: Record<string, unknown>;
  } | null>({
    reducer: (_curr, next) => next,
    default: () => null,
  }),

  /** Whether the graph is paused waiting for human input (HITL gate). */
  awaitingApproval: Annotation<boolean>({
    reducer: (_curr, next) => next,
    default: () => false,
  }),
});

export type GraphState = typeof GraphStateAnnotation.State;
export type GraphStateUpdate = StateGraphArgs<GraphState>['channels'] extends infer _
  ? Partial<GraphState>
  : never;
