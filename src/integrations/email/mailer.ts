import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { ResendClient } from './resend-client.js';

/**
 * Provider-agnostic outbound email surface. Concrete implementation is Resend
 * for v1; the interface stays narrow so swapping in SES / Mailgun later is a
 * single-file change. Notifications are fire-and-forget — callers must not
 * surface email failures back into business logic.
 */
export interface Mailer {
  send(input: {
    to: string;
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
  }): Promise<{ providerMessageId: string }>;
}

class ResendMailer implements Mailer {
  constructor(
    private readonly client: ResendClient,
    private readonly from: string,
  ) {}

  async send(input: {
    to: string;
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
  }): Promise<{ providerMessageId: string }> {
    const result = await this.client.send({
      from: this.from,
      to: input.to,
      subject: input.subject,
      ...(input.html ? { html: input.html } : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    });
    return { providerMessageId: result.id };
  }
}

let cached: Mailer | null = null;
let resolved = false;

/**
 * Returns a configured Mailer or null when notifications are disabled.
 * Disabled = RESEND_API_KEY missing. Throws when the key is set but the
 * sibling NOTIFICATION_FROM_EMAIL is not — that's a misconfiguration we
 * want loud, not a silent no-op.
 */
export function resolveMailer(): Mailer | null {
  if (resolved) return cached;
  resolved = true;
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    logger.info(
      { component: 'mailer' },
      'RESEND_API_KEY not set — notifications disabled (mailer is null)',
    );
    cached = null;
    return null;
  }
  const from = env.NOTIFICATION_FROM_EMAIL;
  if (!from) {
    throw new Error(
      'RESEND_API_KEY is set but NOTIFICATION_FROM_EMAIL is missing — both are required for outbound notifications.',
    );
  }
  cached = new ResendMailer(new ResendClient({ apiKey }), from);
  logger.info({ component: 'mailer', from }, 'mailer ready (Resend)');
  return cached;
}

/** Test helper — drops the cached mailer so a follow-up resolveMailer re-reads env. */
export function clearMailerCache(): void {
  cached = null;
  resolved = false;
}
