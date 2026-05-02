import { HumanMessage } from '@langchain/core/messages';
import type { Task } from '../db/schema/index.js';
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

  // 4-arg emitLog: agents see only the first 3 (event/message/data) — the
  // graph wrapper auto-fills `speaker`. Framework events here pass speaker
  // explicitly ('system' / 'supervisor'). appendTaskLog handles fan-out to
  // the EventBus, so this is just a positional-args adapter.
  const emitLog = (
    event: string,
    message: string,
    data?: Record<string, unknown>,
    speaker?: string,
  ): Promise<void> =>
    appendTaskLog({
      tenantId: task.tenantId,
      taskId: task.id,
      event,
      message,
      ...(speaker ? { speaker } : {}),
      ...(data ? { data } : {}),
    });

  try {
    // No "task.started" — pre-agent framework noise; the agent's own first
    // emitLog (within ~1s) tells the user the worker started.

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
      // Agents emit their own "ready / awaiting" log before returning, so we
      // don't double up here. The one gap is the supervisor: it has no
      // ctx.emitLog, so when *it* returns the awaiting state (clarification
      // path) we mirror its message into the timeline ourselves.
      if (finalState.lastOutput?.agentId === 'supervisor') {
        await emitLog(
          'supervisor.clarified',
          finalState.lastOutput.message,
          undefined,
          'supervisor',
        );
      }
    } else {
      await updateTaskStatus(task.tenantId, task.id, 'done', {
        output: persistedOutput,
        ...kindPatch,
        ...agentPatch,
      });
      await emitLog('task.completed', '任務完成 ✓', undefined, 'system');
    }
  } catch (err) {
    log.error({ err }, 'Task execution failed');
    const errMessage = err instanceof Error ? err.message : 'Unknown error';
    const stack = err instanceof Error ? err.stack : undefined;
    await appendTaskLog({
      tenantId: task.tenantId,
      taskId: task.id,
      level: 'error',
      event: 'task.failed',
      speaker: 'system',
      message: `出狀況了：${errMessage}`,
      ...(stack ? { data: { stack } } : {}),
    });
    await updateTaskStatus(task.tenantId, task.id, 'failed', {
      error: {
        message: errMessage,
        ...(stack ? { stack } : {}),
      },
    });
  } finally {
    await releaseLock(task.id);
  }
}
