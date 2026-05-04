import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, tenantMembers, users } from '../db/schema/index.js';
import { eventBus } from '../events/event-bus.js';
import { resolveMailer } from '../integrations/email/mailer.js';
import { logger } from '../lib/logger.js';
import { buildDoneEmail } from './email.js';
import { decideDoneRecipient, type TaskNotifyOverride } from './recipient.js';

/**
 * Wire the task-done notification flow to the event bus.
 *
 * Subscribes to `task.completed`. For each emitted event:
 *   1. Bail if the mailer isn't configured (Resend key missing).
 *   2. Load the task; bail if it has no createdBy (spawn-children, etc.) —
 *      we only notify on user-initiated tasks to avoid flooding the inbox
 *      when a strategy plan spawns N execution children.
 *   3. Read user.email + tenant_member.notification_settings.
 *   4. Apply decideDoneRecipient (honours per-task override + global toggle).
 *   5. Send. Errors are logged, never re-thrown.
 *
 * Returns an unsubscribe function, useful for tests and graceful shutdown.
 */
export function startNotificationDispatcher(): () => void {
  const log = logger.child({ component: 'notifications' });
  const mailer = resolveMailer();
  if (!mailer) {
    log.info('mailer disabled — skipping dispatcher startup');
    return () => {};
  }

  return eventBus.onTaskCompleted(async ({ taskId, tenantId }) => {
    try {
      const [task] = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)))
        .limit(1);
      if (!task) {
        log.warn({ taskId, tenantId }, 'task vanished before notification dispatch');
        return;
      }
      if (!task.createdBy) {
        // Spawn children — never notify (would flood the inbox on a
        // strategy fan-out). The strategy parent itself has createdBy
        // and gets the single notification covering the whole plan.
        log.debug({ taskId }, 'no createdBy on task — skipping notification');
        return;
      }

      const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, task.createdBy))
        .limit(1);
      if (!user) {
        log.warn({ taskId, userId: task.createdBy }, 'createdBy user missing — skipping');
        return;
      }

      const [member] = await db
        .select({ notificationSettings: tenantMembers.notificationSettings })
        .from(tenantMembers)
        .where(
          and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, task.createdBy)),
        )
        .limit(1);

      const params = (task.input as { params?: Record<string, unknown> })?.params ?? {};
      // Older tasks (pre-notify) have no params.notify — undefined is the
      // standard "fall back to global" signal.
      const notifyOverride = (params as { notify?: TaskNotifyOverride }).notify;

      const recipient = decideDoneRecipient({
        notifyOverride,
        settings: member?.notificationSettings ?? null,
        userEmail: user.email,
      });
      if (!recipient) {
        log.debug({ taskId }, 'recipient resolved to null — no email to send');
        return;
      }

      const { subject, text, html } = buildDoneEmail(task);
      const result = await mailer.send({ to: recipient, subject, text, html });
      log.info(
        { taskId, recipient, providerMessageId: result.providerMessageId },
        'task-done notification sent',
      );
    } catch (err) {
      // Notifications are fire-and-forget; never crash the listener.
      log.error({ err, taskId, tenantId }, 'task-done notification failed');
    }
  });
}
