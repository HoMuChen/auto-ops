import { and, eq } from 'drizzle-orm';
import { agentRegistry } from '../agents/registry.js';
import type { AgentBuildContext, PendingToolCall } from '../agents/types.js';
import { db } from '../db/client.js';
import { type Task, tasks } from '../db/schema/index.js';
import { eventBus } from '../events/event-bus.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { appendTaskLog, getTask, updateTaskStatus } from '../tasks/repository.js';

/**
 * Execute a tool the agent prepared but deferred behind a HITL gate.
 *
 * Flow:
 *   1. Load the task; require status='waiting' and `output.pendingToolCall`.
 *   2. Resolve the assigned agent + build it with a tenant-scoped context so
 *      its `tools[]` array carries credentials/config bound at this moment.
 *   3. Find the tool by id, invoke it with the persisted args.
 *   4. On success: stamp `output.toolResult`, transition to done. Idempotent —
 *      a retry sees `toolResult` already set and returns the existing task.
 *   5. On failure: status='failed' with the error captured.
 *
 * The agent's own `invoke()` is NOT called here — the LLM already produced the
 * intent before the gate, so re-running it would be wasteful and risk drift.
 * We only need its tool definitions, which are pure functions of (manifest,
 * tenant config, credentials) and built deterministically.
 */
export async function executeApprovedToolCall(tenantId: string, taskId: string): Promise<Task> {
  const log = logger.child({ taskId, tenantId, op: 'tool-executor' });

  const task = await getTask(tenantId, taskId);

  const output = (task.output ?? {}) as Record<string, unknown> & {
    pendingToolCall?: PendingToolCall;
    toolResult?: unknown;
    toolExecutedAt?: string;
  };

  if (!output.pendingToolCall) {
    throw new ConflictError(`Task ${taskId} has no pendingToolCall to execute`);
  }

  // Idempotent re-entry: if the tool already fired (network retry on /approve),
  // just return the task without re-invoking. The agent's external mutation
  // is not assumed safe to repeat.
  if (output.toolExecutedAt && task.status === 'done') {
    return task;
  }

  if (task.status !== 'waiting') {
    throw new ConflictError(
      `Task ${taskId} is in '${task.status}', expected 'waiting' before tool execution`,
    );
  }

  if (!task.assignedAgent) {
    throw new ConflictError(
      `Task ${taskId} has pendingToolCall but no assignedAgent — framework cannot resolve the tool`,
    );
  }

  const pending = output.pendingToolCall;
  const agent = agentRegistry.get(task.assignedAgent);

  // Emit logs through the same channel the runner uses so the SSE stream and
  // task_logs stay coherent across a (LLM run → HITL → tool fire) lifecycle.
  const emitLog = async (
    event: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> => {
    await appendTaskLog({ tenantId, taskId, event, message, data });
    eventBus.publish(taskId, { event, message, data, at: new Date().toISOString() });
  };

  await emitLog('tool.started', `Executing ${pending.id} after HITL approval`, {
    agentId: agent.manifest.id,
  });

  // Build a minimal context — tool execution doesn't need a model call, but
  // build() needs the full ctx shape so the closure captures tenant + config.
  const override = await agentRegistry.loadConfig(tenantId, agent.manifest.id);
  const ctx: AgentBuildContext = {
    tenantId,
    taskId,
    modelConfig: agent.manifest.defaultModel,
    systemPrompt: override.promptOverride ?? agent.manifest.defaultPrompt,
    ...(override.toolWhitelist ? { toolWhitelist: override.toolWhitelist } : {}),
    agentConfig: override.config,
    availableExecutionAgents: [],
    emitLog,
  };

  const runnable = await agent.build(ctx);
  const tool = runnable.tools.find((t) => t.id === pending.id);
  if (!tool) {
    const known = runnable.tools.map((t) => t.id).join(', ') || '(none)';
    throw new NotFoundError(
      `Tool ${pending.id} not exposed by agent ${agent.manifest.id}. Known: ${known}`,
    );
  }

  let result: unknown;
  try {
    result = await tool.tool.invoke(pending.args);
  } catch (err) {
    log.error({ err }, 'Tool execution failed');
    const message = err instanceof Error ? err.message : String(err);
    await emitLog('tool.failed', `Tool ${pending.id} failed: ${message}`);
    await updateTaskStatus(tenantId, taskId, 'failed', {
      error: { message, stack: err instanceof Error ? err.stack : undefined },
    });
    throw err;
  }

  await emitLog('tool.completed', `Tool ${pending.id} succeeded`, {
    resultPreview:
      typeof result === 'string' ? result.slice(0, 200) : 'structured (see task.output.toolResult)',
  });

  // Inline UPDATE — updateTaskStatus's typed patch surface doesn't yet allow
  // arbitrary output merges, and we want to add toolResult/toolExecutedAt
  // without dropping the existing payload (listing, language, etc).
  const nextOutput = {
    ...output,
    pendingToolCall: undefined,
    toolResult: result,
    toolExecutedAt: new Date().toISOString(),
  };

  const [updated] = await db
    .update(tasks)
    .set({
      status: 'done',
      output: nextOutput,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)))
    .returning();

  if (!updated) throw new NotFoundError(`Task ${taskId} disappeared during tool execution`);

  await emitLog('task.completed', 'Task completed via post-approval tool execution');

  return updated;
}
