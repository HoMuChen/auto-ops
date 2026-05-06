import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { Task } from '../db/schema/index.js';
import { LockLostError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { buildGraph, initialState } from '../orchestrator/graph.js';
import { appendMessage, listMessages } from './messages.js';
import { appendTaskLog, extendLock, releaseLock, updateTaskStatus } from './repository.js';

/** How often to extend the lock while the runner is active. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** How far ahead the lease is pushed on each heartbeat. Must exceed interval. */
const HEARTBEAT_LEASE_MS = 5 * 60_000;

/**
 * Execute one task through LangGraph.
 *
 * - For a fresh task: seed initial state from `task.input` + the latest user message.
 * - For a resumed task (after Approve/Feedback): the checkpointer rehydrates state
 *   from thread_id == task.threadId; we just invoke with no new messages.
 *
 * On HITL gate: graph returns with awaitingApproval=true → transition task to
 * 'waiting'. On completion: transition to 'done'. On error: 'failed'.
 *
 * Lease management: a setInterval extends `tasks.locked_until` every 30s while
 * this runner is active so multi-hop research agents (which can easily exceed
 * the 5-min initial lease) don't get reclaimed mid-run by another worker tick.
 * If the heartbeat detects the lock was taken (DB returns 0 rows updated), we
 * stop writing task state — the new owner is now the source of truth, and
 * `updateTaskStatus`/`releaseLock` would either be no-ops or throw `LockLostError`
 * via the owner-guard in repository.ts.
 */
export async function runTaskThroughGraph(task: Task, workerId: string): Promise<void> {
  const log = logger.child({ taskId: task.id, tenantId: task.tenantId, workerId });

  let lockLost = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const ok = await extendLock(task.id, workerId, HEARTBEAT_LEASE_MS);
        if (!ok && !lockLost) {
          lockLost = true;
          log.warn(
            'lease lost mid-run — another worker has claimed this task; further state writes will be skipped',
          );
        }
      } catch (err) {
        // Transient DB error — don't flip lockLost; the next tick can recover.
        // If the DB is durably broken the runner will fail anyway.
        log.warn({ err }, 'heartbeat extendLock failed (will retry on next tick)');
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);

  // 4-arg emitLog: agents see only the first 3 (event/message/data) — the
  // graph wrapper auto-fills `speaker`. Framework events here pass speaker
  // explicitly ('system' / 'supervisor'). appendTaskLog handles fan-out to
  // the EventBus, so this is just a positional-args adapter.
  //
  // Mirror to pino at debug so dev terminals can watch supervisor / agent /
  // tool activity without subscribing to SSE. PREFIX_KEYS in logger.ts lifts
  // event/speaker/agentId into the bracket prefix.
  const emitLog = (
    event: string,
    message: string,
    data?: Record<string, unknown>,
    speaker?: string,
  ): Promise<void> => {
    log.debug({ event, ...(speaker ? { speaker } : {}), ...(data ? { data } : {}) }, message);
    return appendTaskLog({
      tenantId: task.tenantId,
      taskId: task.id,
      event,
      message,
      ...(speaker ? { speaker } : {}),
      ...(data ? { data } : {}),
    });
  };

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
      const taskImageIds = history.flatMap(
        (m) => (m.data as { imageIds?: string[] } | null)?.imageIds ?? [],
      );
      invokeInput = {
        ...initialState({
          tenantId: task.tenantId,
          taskId: task.id,
          brief,
          params: (task.input as Record<string, unknown>) ?? {},
          // Execution children carry an explicit owner; pinning bypasses the
          // supervisor LLM on the first hop. Strategy parents leave this null.
          pinnedAgent: task.assignedAgent,
          taskImageIds: taskImageIds.length > 0 ? taskImageIds : null,
        }),
        currentTaskOutput: (task.output ?? null) as Record<string, unknown> | null,
      };
    } else {
      // Resumed run: append only the user messages the checkpoint hasn't seen yet.
      //
      // The state's `messages` reducer is append-only (orchestrator/state.ts),
      // so anything in `invokeInput.messages` adds to history rather than
      // replacing it. Naïvely pushing "the latest user msg from the DB" works
      // after feedback (a genuinely new entry) but on lease-reclaim or
      // approve(finalize=false) re-runs the latest user msg IS the original
      // brief that's already in state — pushing it again duplicates the
      // prompt and burns tokens.
      //
      // Diff via content membership rather than count: spawned children carry
      // their brief in `task.input` (never inserted into `messages` table),
      // while directly-created tasks have the brief in `messages`. A simple
      // count-diff between state.human-msgs and db.user-msgs gives the wrong
      // answer for spawned children. Comparing string contents is robust
      // across both cases — if the model already saw a given user string,
      // skip it; otherwise push.
      const history = await listMessages(task.tenantId, task.id);
      const stateMessages = (checkpoint.values?.messages as BaseMessage[] | undefined) ?? [];
      const seen = new Set(
        stateMessages
          .filter((m) => m.getType() === 'human')
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
      );
      const newUserMsgs = history.filter((m) => m.role === 'user' && !seen.has(m.content));

      const taskImageIds = history.flatMap(
        (m) => (m.data as { imageIds?: string[] } | null)?.imageIds ?? [],
      );
      invokeInput = {
        messages: newUserMsgs.map((m) => new HumanMessage(m.content)),
        currentTaskOutput: (task.output ?? null) as Record<string, unknown> | null,
        taskImageIds: taskImageIds.length > 0 ? taskImageIds : null,
        // Reset the HITL gate so the supervisor doesn't short-circuit on the
        // next invocation. Re-pin the agent (stamped by the previous run) so the
        // supervisor skips its LLM call and routes directly back to the same agent.
        awaitingApproval: false,
        ...(task.assignedAgent ? { pinnedAgent: task.assignedAgent, lastOutput: null } : {}),
      };
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
          ...(finalState.lastOutput.artifact ? { artifact: finalState.lastOutput.artifact } : {}),
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

    if (lockLost) {
      log.info(
        'skipping post-run status update — lock was reclaimed during execution; new owner will write final state',
      );
      return;
    }

    if (finalState.awaitingApproval) {
      await updateTaskStatus(
        task.tenantId,
        task.id,
        'waiting',
        { output: persistedOutput, ...kindPatch, ...agentPatch },
        workerId,
      );
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
      await updateTaskStatus(
        task.tenantId,
        task.id,
        'done',
        { output: persistedOutput, ...kindPatch, ...agentPatch },
        workerId,
      );
      await emitLog('task.completed', '任務完成 ✓', undefined, 'system');
    }
  } catch (err) {
    // LockLostError from updateTaskStatus on the success path: the new owner
    // beat us to writing the final state. Don't escalate, don't double-write.
    if (err instanceof LockLostError) {
      log.warn({ err }, 'lock lost while finalizing task — abandoning silently');
      return;
    }
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
    if (lockLost) {
      log.info('skipping failed-status update — lock was reclaimed during execution');
      return;
    }
    try {
      await updateTaskStatus(
        task.tenantId,
        task.id,
        'failed',
        { error: { message: errMessage, ...(stack ? { stack } : {}) } },
        workerId,
      );
    } catch (statusErr) {
      if (statusErr instanceof LockLostError) {
        log.warn({ err: statusErr }, 'lock lost while writing failed status — abandoning');
      } else {
        throw statusErr;
      }
    }
  } finally {
    clearInterval(heartbeat);
    // Owner-guarded release: no-op if we already lost the lock. Skipping
    // entirely on lockLost is also fine, but the WHERE check makes it safe
    // to call regardless and keeps the cleanup path uniform.
    await releaseLock(task.id, workerId);
  }
}
