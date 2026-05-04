import { describe, expect, it, vi } from 'vitest';
import { WebFetchClient } from '../src/integrations/web/client.js';
import { buildWebFetchTools } from '../src/integrations/web/tools.js';

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }) as Response;
}

describe('WebFetchClient', () => {
  it('extracts main content and reports truncated=false when within cap', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<html><body><article>hello world</article></body></html>'));
    const client = new WebFetchClient({ fetchImpl: fetchImpl as never });
    const result = await client.fetch({ url: 'https://example.com/post' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.text).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.status).toBe(200);
  });

  it('truncates oversized text and flags truncated=true', async () => {
    const big = '<html><body><article>' + 'x'.repeat(15_000) + '</article></body></html>';
    const fetchImpl = vi.fn(async () => htmlResponse(big));
    const client = new WebFetchClient({ fetchImpl: fetchImpl as never, defaultMaxChars: 1000 });
    const result = await client.fetch({ url: 'https://example.com/big' });
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(1000);
  });

  it('honours per-call maxChars but caps at hardMaxChars', async () => {
    const big = '<html><body><article>' + 'y'.repeat(50_000) + '</article></body></html>';
    const fetchImpl = vi.fn(async () => htmlResponse(big));
    const client = new WebFetchClient({ fetchImpl: fetchImpl as never, hardMaxChars: 5000 });
    const result = await client.fetch({ url: 'https://example.com/x', maxChars: 99_999 });
    expect(result.text).toHaveLength(5000);
    expect(result.truncated).toBe(true);
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 503, headers: { 'content-type': 'text/html' } }),
    );
    const client = new WebFetchClient({ fetchImpl: fetchImpl as never });
    await expect(client.fetch({ url: 'https://example.com/down' })).rejects.toThrow(/503/);
  });

  it('throws on non-HTML content type', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = new WebFetchClient({ fetchImpl: fetchImpl as never });
    await expect(client.fetch({ url: 'https://example.com/api' })).rejects.toThrow(/non-HTML/);
  });

  it('sends a real User-Agent so we are not auto-blocked', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      htmlResponse('<html><body><p>x</p></body></html>'),
    );
    const client = new WebFetchClient({ fetchImpl: fetchImpl as never });
    await client.fetch({ url: 'https://example.com/' });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['User-Agent']).toMatch(/auto-ops-research/);
  });
});

describe('buildWebFetchTools', () => {
  it('exposes web.fetch tool that delegates to the client', async () => {
    const client = {
      fetch: vi.fn(async () => ({
        url: 'https://x.test/a',
        finalUrl: 'https://x.test/a',
        status: 200,
        title: 't',
        text: 'body',
        truncated: false,
      })),
    };
    const tools = buildWebFetchTools({ client: client as never });
    const tool = tools.find((t) => t.id === 'web.fetch');
    expect(tool).toBeDefined();
    const result = await tool!.tool.invoke({ url: 'https://x.test/a' });
    expect(client.fetch).toHaveBeenCalledWith({ url: 'https://x.test/a' });
    expect(result).toMatchObject({ title: 't', text: 'body', truncated: false });
  });

  it('forwards maxChars when provided', async () => {
    const client = {
      fetch: vi.fn(async () => ({
        url: 'https://x.test/a',
        finalUrl: 'https://x.test/a',
        status: 200,
        text: 'short',
        truncated: false,
      })),
    };
    const tools = buildWebFetchTools({ client: client as never });
    const tool = tools.find((t) => t.id === 'web.fetch');
    await tool!.tool.invoke({ url: 'https://x.test/a', maxChars: 2000 });
    expect(client.fetch).toHaveBeenCalledWith({ url: 'https://x.test/a', maxChars: 2000 });
  });
});
