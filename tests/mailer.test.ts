import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEnvCache } from '../src/config/env.js';
import { clearMailerCache, resolveMailer } from '../src/integrations/email/mailer.js';
import { ResendClient } from '../src/integrations/email/resend-client.js';

describe('ResendClient', () => {
  it('POSTs to /emails with bearer auth and returns the message id', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ id: 'msg_123' }, { status: 200 }),
    );
    const client = new ResendClient({ apiKey: 'rk_test', fetchImpl: fetchImpl as never });
    const result = await client.send({
      from: 'auto-ops <noreply@x.test>',
      to: 'user@x.test',
      subject: 'hi',
      text: 'body',
    });
    expect(result).toEqual({ id: 'msg_123' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe('https://api.resend.com/emails');
    const init = call?.[1];
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer rk_test');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body).toEqual({
      from: 'auto-ops <noreply@x.test>',
      to: 'user@x.test',
      subject: 'hi',
      text: 'body',
    });
  });

  it('renames replyTo to reply_to in the wire payload', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ id: 'msg_x' }, { status: 200 }),
    );
    const client = new ResendClient({ apiKey: 'rk', fetchImpl: fetchImpl as never });
    await client.send({
      from: 'a@x.test',
      to: 'b@x.test',
      subject: 's',
      text: 't',
      replyTo: 'reply@x.test',
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.reply_to).toBe('reply@x.test');
    expect(body.replyTo).toBeUndefined();
  });

  it('throws when the provider returns non-2xx', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429, headers: {} }),
    );
    const client = new ResendClient({ apiKey: 'rk', fetchImpl: fetchImpl as never });
    await expect(
      client.send({ from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't' }),
    ).rejects.toThrow(/Resend 429/);
  });
});

describe('resolveMailer', () => {
  const originalKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.NOTIFICATION_FROM_EMAIL;

  beforeEach(() => {
    clearEnvCache();
    clearMailerCache();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
    if (originalFrom === undefined) delete process.env.NOTIFICATION_FROM_EMAIL;
    else process.env.NOTIFICATION_FROM_EMAIL = originalFrom;
    clearEnvCache();
    clearMailerCache();
  });

  it('returns null when RESEND_API_KEY is unset (notifications disabled)', () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFICATION_FROM_EMAIL;
    expect(resolveMailer()).toBeNull();
  });

  it('throws loudly when the API key is set but NOTIFICATION_FROM_EMAIL is missing', () => {
    process.env.RESEND_API_KEY = 'rk_test';
    delete process.env.NOTIFICATION_FROM_EMAIL;
    expect(() => resolveMailer()).toThrow(/NOTIFICATION_FROM_EMAIL is missing/);
  });

  it('returns a usable Mailer when both env vars are present', () => {
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.NOTIFICATION_FROM_EMAIL = 'auto-ops <noreply@x.test>';
    const mailer = resolveMailer();
    expect(mailer).not.toBeNull();
    expect(typeof mailer?.send).toBe('function');
  });

  it('caches the resolved mailer so repeated calls do not re-read env', () => {
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.NOTIFICATION_FROM_EMAIL = 'noreply@x.test';
    const first = resolveMailer();
    const second = resolveMailer();
    expect(first).toBe(second);
  });
});
