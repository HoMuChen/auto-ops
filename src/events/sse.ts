import type { FastifyReply, FastifyRequest } from 'fastify';
import { getStreamCursor, getTask, listTaskLogs, listTenantLogs } from '../tasks/repository.js';
import { type TaskLogEvent, eventBus } from './event-bus.js';

/**
 * SSE handler for per-task log streaming.
 *
 * Protocol:
 *   - On connect, replays existing logs since `?since=<ISO>` (or all if absent).
 *   - Subscribes to live events from the EventBus and writes them as SSE frames.
 *   - Sends a heartbeat every 15s to keep proxies/load balancers happy.
 *
 * Client expectation: standard EventSource — reconnect with `Last-Event-ID` is
 * supported; the handler reads `Last-Event-ID` header on reconnect and replays
 * from that timestamp.
 */
export async function streamTaskLogs(
  req: FastifyRequest<{ Params: { taskId: string }; Querystring: { since?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenantId = req.tenantId;
  if (!tenantId) {
    reply.code(403).send({ error: 'tenant context required' });
    return;
  }
  const { taskId } = req.params;

  // Verify the task belongs to this tenant BEFORE opening the SSE stream — the
  // EventBus is keyed only on taskId, so without this check a caller could
  // subscribe to live logs of any task whose UUID they know.
  await getTask(tenantId, taskId); // throws NotFoundError → 404 via error handler

  const lastEventId = req.headers['last-event-id'];
  const sinceParam = (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ?? req.query.since;
  const since = sinceParam ? new Date(sinceParam) : undefined;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (event: TaskLogEvent): void => {
    reply.raw.write(`id: ${event.at}\n`);
    reply.raw.write(`event: ${event.event}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // 1. Replay
  const historical = await listTaskLogs(tenantId, taskId, { since });
  for (const row of historical) {
    write({
      event: row.event,
      message: row.message,
      ...(row.speaker ? { speaker: row.speaker } : {}),
      data: row.data ?? undefined,
      at: row.createdAt.toISOString(),
    });
  }

  // 2. Live
  const unsubscribe = eventBus.subscribe(taskId, write);

  const heartbeat = setInterval(() => {
    reply.raw.write(': keep-alive\n\n');
  }, 15_000);

  const close = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    if (!reply.raw.writableEnded) reply.raw.end();
  };

  req.raw.on('close', close);
  req.raw.on('error', close);
}

/**
 * SSE handler for tenant-wide log streaming.
 *
 * Same protocol as streamTaskLogs but covers ALL tasks for the tenant.
 * Each event includes `taskId` so the client can route logs to the correct card.
 */
export async function streamTenantLogs(
  req: FastifyRequest<{ Querystring: { since?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenantId = req.tenantId;
  if (!tenantId) {
    reply.code(403).send({ error: 'tenant context required' });
    return;
  }

  const lastEventId = req.headers['last-event-id'];
  const sinceParam = (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ?? req.query.since;

  let since: Date | undefined;
  if (sinceParam) {
    since = new Date(sinceParam);
  } else {
    // No explicit since: use the user's stored cursor as the replay start point.
    // Falls back to 24h ago for first-time connections (no cursor stored yet).
    const userId = req.user?.id;
    const cursor = userId ? await getStreamCursor(userId, tenantId) : null;
    since = cursor ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (event: TaskLogEvent): void => {
    reply.raw.write(`id: ${event.at}\n`);
    reply.raw.write(`event: ${event.event}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // 1. Replay
  const historical = await listTenantLogs(tenantId, { since });
  for (const row of historical) {
    write({
      taskId: row.taskId,
      event: row.event,
      message: row.message,
      ...(row.speaker ? { speaker: row.speaker } : {}),
      data: row.data ?? undefined,
      at: row.createdAt.toISOString(),
    });
  }

  // 2. Live
  const unsubscribe = eventBus.subscribeToTenant(tenantId, write);

  const heartbeat = setInterval(() => {
    reply.raw.write(': keep-alive\n\n');
  }, 15_000);

  const close = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    if (!reply.raw.writableEnded) reply.raw.end();
  };

  req.raw.on('close', close);
  req.raw.on('error', close);
}
