import { HumanMessage } from '@langchain/core/messages';
import type { Task } from '../db/schema/index.js';
import { eventBus } from '../events/event-bus.js';
import { logger } from '../lib/logger.js';
import { buildGraph, initialState } from '../orchestrator/graph.js';
import { appendMessage, listMessages } from './messages.js';
import { appendTaskLog, releaseLock, updateTaskStatus } from './repository.js';

/**
 * Execute one task through LangGraph.
 *
 * - For a fresh task: seed initial state from `task.input` + the latest user message.
 * - For a resumed task (after Approve/Feedback): the checkpointer rehydrates state
 *   from thread_id == task.threadId; we just invoke with no new messages.
 *
 * On HITL gate: graph returns with awaitingApproval=true → transition task to
 * 'waiting'. On completion: transition to 'done'. On error: 'failed'.
 */
export async function runTaskThroughGraph(task: Task): Promise<void> {
  const log = logger.child({ taskId: task.id, tenantId: task.tenantId });

  const emitLog = async (
    event: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> => {
    await appendTaskLog({ tenantId: task.tenantId, taskId: task.id, event, message, data });
    eventBus.publish(task.id, { event, message, data, at: new Date().toISOString() });
  };

  try {
    await emitLog('task.started', `Task ${task.id} entering graph`);

    const graph = await buildGraph({
      tenantId: task.tenantId,
      taskId: task.id,
      emitLog,
    });

    const config = { configurable: { thread_id: task.threadId } };

    // Determine seed: if no checkpoint yet, seed from task input + latest user message.
    const checkpoint = await graph.getState(config);
    const isFresh = checkpoint.values?.taskId === undefined;

    let invokeInput: Record<string, unknown> | null = null;
    if (isFresh) {
      const history = await listMessages(task.tenantId, task.id);
      const brief =
        history.find((m) => m.role === 'user')?.content ??
        (typeof task.input?.brief === 'string' ? task.input.brief : task.title);
      invokeInput = initialState({
        tenantId: task.tenantId,
        taskId: task.id,
        brief,
        params: (task.input as Record<string, unknown>) ?? {},
        // Execution children carry an explicit owner; pinning bypasses the
        // supervisor LLM on the first hop. Strategy parents leave this null.
        pinnedAgent: task.assignedAgent,
      });
    } else {
      // Resumed run: pull any new user messages since last checkpoint and inject.
      const history = await listMessages(task.tenantId, task.id);
      const latestUser = history.filter((m) => m.role === 'user').slice(-1)[0];
      invokeInput = latestUser ? { messages: [new HumanMessage(latestUser.content)] } : null;
    }

    const finalState = await graph.invoke(invokeInput as never, config);

    if (finalState.lastOutput) {
      await appendMessage({
        tenantId: task.tenantId,
        taskId: task.id,
        role: 'assistant',
        content: finalState.lastOutput.message,
        agentKey: finalState.lastOutput.agentId,
      });
    }

    // Merge agent payload with framework-level intents (spawnTasks,
    // pendingToolCall) so the approve route can read them from task.output
    // without needing access to graph state.
    const persistedOutput = finalState.lastOutput
      ? {
          ...(finalState.lastOutput.payload ?? {}),
          ...(finalState.lastOutput.spawnTasks
            ? { spawnTasks: finalState.lastOutput.spawnTasks }
            : {}),
          ...(finalState.lastOutput.pendingToolCall
            ? { pendingToolCall: finalState.lastOutput.pendingToolCall }
            : {}),
        }
      : null;

    // Auto-promote to strategy kind whenever the agent emitted children. This
    // keeps `task.kind` consistent with the actual behaviour at finalize time
    // even if POST /v1/tasks created the row as the default 'execution'.
    const hasSpawn = (finalState.lastOutput?.spawnTasks?.length ?? 0) > 0;
    const kindPatch: { kind?: 'strategy' } = hasSpawn ? { kind: 'strategy' } : {};

    // Stamp the agent that produced the latest output so downstream paths
    // (post-approval tool executor, audit log, kanban grouping) don't need to
    // guess. The supervisor may have picked it dynamically — the task row
    // wouldn't otherwise know.
    const agentPatch: { assignedAgent?: string } = finalState.lastOutput?.agentId
      ? { assignedAgent: finalState.lastOutput.agentId }
      : {};

    if (finalState.awaitingApproval) {
      await updateTaskStatus(task.tenantId, task.id, 'waiting', {
        output: persistedOutput,
        ...kindPatch,
        ...agentPatch,
      });
      await emitLog('task.waiting', 'Task awaiting human approval', {
        pendingSpawnCount: finalState.lastOutput?.spawnTasks?.length ?? 0,
      });
    } else {
      await updateTaskStatus(task.tenantId, task.id, 'done', {
        output: persistedOutput,
        ...kindPatch,
        ...agentPatch,
      });
      await emitLog('task.completed', 'Task completed successfully');
    }
  } catch (err) {
    log.error({ err }, 'Task execution failed');
    await appendTaskLog({
      tenantId: task.tenantId,
      taskId: task.id,
      level: 'error',
      event: 'task.failed',
      message: err instanceof Error ? err.message : 'Unknown error',
      data: { stack: err instanceof Error ? err.stack : undefined },
    });
    await updateTaskStatus(task.tenantId, task.id, 'failed', {
      error: {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    });
  } finally {
    await releaseLock(task.id);
  }
}
