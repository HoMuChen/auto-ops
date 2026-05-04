import { z } from 'zod';

const ResendSendResponseSchema = z.object({
  id: z.string(),
});

export type ResendSendResponse = z.infer<typeof ResendSendResponseSchema>;

export interface ResendSendInput {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
}

export class ResendClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: { apiKey: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async send(input: ResendSendInput): Promise<ResendSendResponse> {
    const body: Record<string, unknown> = {
      from: input.from,
      to: input.to,
      subject: input.subject,
    };
    if (input.html) body.html = input.html;
    if (input.text) body.text = input.text;
    if (input.replyTo) body.reply_to = input.replyTo;

    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Resend ${res.status}: ${text.slice(0, 200)}`);
    }
    return ResendSendResponseSchema.parse(await res.json());
  }
}
