import type { NotificationSettings } from '../db/schema/users.js';

/**
 * The shape `task.input.params.notify` accepts. UI-visible contract.
 *
 * - undefined / unset — follow the user's global notification_settings
 * - false — explicit opt-out (overrides global ON)
 * - true | {} — opt-in to the user's own account email
 * - { email: string } — opt-in to a specific address
 */
export type TaskNotifyOverride =
  | boolean
  | { email?: string | null }
  | null
  | undefined;

/**
 * Decide who (if anyone) should receive a "task done" notification.
 *
 * Returns the recipient email, or null when the email should not be sent.
 * Pure function — no DB access, no I/O, easy to unit test.
 */
export function decideDoneRecipient(input: {
  /** The opt-in/out override stamped on the task at creation time. */
  notifyOverride: TaskNotifyOverride;
  /** The user's per-tenant settings (or null if no row exists). */
  settings: NotificationSettings | null;
  /** The user's account email — used as the default recipient. */
  userEmail: string | null;
}): string | null {
  const { notifyOverride, settings, userEmail } = input;

  if (notifyOverride === false) return null;

  if (notifyOverride === true) return userEmail;

  if (typeof notifyOverride === 'object' && notifyOverride !== null) {
    const explicit = notifyOverride.email?.trim();
    if (explicit) return explicit;
    return userEmail;
  }

  // notifyOverride is undefined / null — fall back to global setting.
  return settings?.notifyOnDone ? userEmail : null;
}
