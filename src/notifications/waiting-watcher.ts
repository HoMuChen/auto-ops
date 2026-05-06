import { and, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { tenantMembers, users } from '../db/schema/index.js';
import { resolveMailer } from '../integrations/email/mailer.js';
import { logger } from '../lib/logger.js';
import { claimWaitingTaskForNotification, resolveOwningCreator } from '../tasks/repository.js';
import { buildWaitingEmail } from './email.js';
import { type TaskNotifyOverride, decideWaitingRecipient } from './recipient.js';

/**
 * Polling watcher that sends "task is waiting on you" emails.
 *
 * Loop (every NOTIFICATION_WAITING_POLL_MS):
 *   while a row is claimable:
 *     - claim one task whose status='waiting' AND updated_at <= now() - threshold
 *       AND output.notifiedWaitingAt IS NULL  (atomic UPDATE … FOR UPDATE SKIP LOCKED)
 *     - resolve recipient via per-task notify override + (user, tenant) settings
 *     - send via Resend
 *     - on failure, log and move on (the stamp is already set; we deliberately
 *       don't roll it back to avoid retry-storms — better silent than spammy)
 *
 * The stamp itself is the dedup key. `updateTaskStatus` clears it on transitions
 * out of waiting, so if the boss gives feedback and a second draft eventually
 * lands back in waiting, the watcher will fire again.
 *
 * Spawn-children fallback: a strategy fan-out creates execution children with
 * `createdBy=null` (so done emails don't flood). For waiting we still need to
 * notify a human, so we walk up parentTaskId via `resolveOwningCreator` to find
 * the strategy parent's createdBy. Each child still gets its own email — they're
 * independent HITL gates and the boss needs to act on each one.
 */
export function startWaitingWatcher(): () => void {
  const log = logger.child({ component: 'waiting-watcher' });
  const mailer = resolveMailer();
  if (!mailer) {
    log.info('mailer disabled — skipping waiting-watcher startup');
    return () => {};
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  // Cap the per-tick work so a backlog doesn't lock the loop on first boot;
  // unprocessed rows fall through to the next tick naturally.
  const MAX_PER_TICK = 25;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      for (let i = 0; i < MAX_PER_TICK; i++) {
        const task = await claimWaitingTaskForNotification({
          thresholdMs: env.NOTIFICATION_WAITING_THRESHOLD_MS,
        });
        if (!task) break;

        const ownerId = await resolveOwningCreator(task);
        if (!ownerId) {
          log.debug({ taskId: task.id }, 'no owning creator resolvable — skipping');
          continue;
        }

        const [user] = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, ownerId))
          .limit(1);
        if (!user) {
          log.warn({ taskId: task.id, ownerId }, 'owning user missing — skipping');
          continue;
        }

        const [member] = await db
          .select({ notificationSettings: tenantMembers.notificationSettings })
          .from(tenantMembers)
          .where(and(eq(tenantMembers.tenantId, task.tenantId), eq(tenantMembers.userId, ownerId)))
          .limit(1);

        const params = (task.input as { params?: Record<string, unknown> })?.params ?? {};
        const notifyOverride = (params as { notify?: TaskNotifyOverride }).notify;

        const recipient = decideWaitingRecipient({
          notifyOverride,
          settings: member?.notificationSettings ?? null,
          userEmail: user.email,
        });
        if (!recipient) {
          log.debug({ taskId: task.id }, 'recipient resolved to null — skipping send');
          continue;
        }

        try {
          const { subject, text, html } = buildWaitingEmail(task);
          const result = await mailer.send({
            to: recipient,
            subject,
            text,
            html,
            ...(env.NOTIFICATION_REPLY_TO_EMAIL
              ? { replyTo: env.NOTIFICATION_REPLY_TO_EMAIL }
              : {}),
          });
          log.info(
            { taskId: task.id, recipient, providerMessageId: result.providerMessageId },
            'task-waiting notification sent',
          );
        } catch (err) {
          // Stamp is already set — we don't retry. Loud log so ops can see.
          log.error({ err, taskId: task.id }, 'task-waiting notification send failed');
        }
      }
    } catch (err) {
      log.error({ err }, 'waiting-watcher tick error');
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), env.NOTIFICATION_WAITING_POLL_MS);
      }
    }
  };

  log.info(
    {
      pollMs: env.NOTIFICATION_WAITING_POLL_MS,
      thresholdMs: env.NOTIFICATION_WAITING_THRESHOLD_MS,
    },
    'waiting-watcher starting',
  );
  // First tick on a small delay so boot ordering (DB connect, agent registry)
  // is unambiguous before we touch the tasks table.
  timer = setTimeout(() => void tick(), 5_000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    log.info('waiting-watcher stopped');
  };
}
