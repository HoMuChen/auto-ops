import { and, eq } from 'drizzle-orm';
import { agentRegistry } from '../agents/registry.js';
import type { AgentBuildContext } from '../agents/types.js';
import { db } from '../db/client.js';
import { type Task, tasks } from '../db/schema/index.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type {
  AnyArtifact,
  BlogPublishedMeta,
  ProductPublishedMeta,
} from '../tasks/artifact.js';
import { readTaskOutput } from '../tasks/output.js';
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
  const output = readTaskOutput(task);

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

  // Tool execution is the agent acting on the boss's approval — speaker is
  // the agent that prepared the call, not 'system'.
  const speaker = agent.manifest.id;
  const emitLog = (event: string, message: string, data?: Record<string, unknown>): Promise<void> =>
    appendTaskLog({ tenantId, taskId, event, message, speaker, ...(data ? { data } : {}) });

  await emitLog('tool.started', '收到指示，我來執行', {
    toolId: pending.id,
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
    await emitLog('tool.failed', `失敗了，我這邊回報的錯誤：${message}`, {
      toolId: pending.id,
    });
    await updateTaskStatus(tenantId, taskId, 'failed', {
      error: { message, stack: err instanceof Error ? err.stack : undefined },
    });
    throw err;
  }

  await emitLog('tool.completed', '處理好了 ✓', {
    toolId: pending.id,
    resultPreview:
      typeof result === 'string'
        ? result.slice(0, 200)
        : 'structured (see task.output.artifact.refs.published or .published)',
  });

  // Stamp publish metadata onto the artifact so the UI can render
  // "已發布到 Shopify" without reading agent-specific fields. New shape
  // uses `refs.published`; legacy shape uses `artifact.published` (kept
  // until Task 10 removes the discriminated union).
  const nextArtifact = stampPublishedOnArtifact(output.artifact, pending.id, result);

  const nextOutput = {
    ...output,
    pendingToolCall: undefined,
    ...(nextArtifact ? { artifact: nextArtifact } : {}),
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

  // Final framework summary line — speaker switches to 'system' since this
  // wraps up the whole task, not the agent's tool call specifically.
  await appendTaskLog({
    tenantId,
    taskId,
    event: 'task.completed',
    speaker: 'system',
    message: '任務完成 ✓',
  });

  return updated;
}

function stampPublishedOnArtifact(
  current: AnyArtifact | undefined,
  toolId: string,
  result: unknown,
): AnyArtifact | undefined {
  if (!current) return undefined;

  // New flat artifact: stamp the publish metadata into refs.published so the
  // UI artifact panel can read it without knowing which kind of agent emitted
  // it. Tool-id check is kept loose — every publish-style tool's result lives
  // in the same place.
  if (!('kind' in current)) {
    if (toolId === 'shopify.publish_article' || toolId === 'shopify.create_product') {
      return {
        ...current,
        refs: { ...(current.refs ?? {}), published: result },
      };
    }
    return current;
  }

  // Legacy discriminated-union artifacts — kept until Task 10 deletes them.
  if (toolId === 'shopify.publish_article' && current.kind === 'blog-article') {
    return { ...current, published: result as BlogPublishedMeta };
  }
  if (toolId === 'shopify.create_product' && current.kind === 'product-content') {
    return { ...current, published: result as ProductPublishedMeta };
  }
  return current;
}
