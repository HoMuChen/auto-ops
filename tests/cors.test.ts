import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearEnvCache } from '../src/config/env.js';
import { createServer } from '../src/server.js';

const ORIGINAL = process.env.CORS_ALLOWED_ORIGINS;

async function buildApp(): Promise<FastifyInstance> {
  const app = await createServer();
  await app.ready();
  return app;
}

beforeEach(() => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  clearEnvCache();
});

afterEach(() => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  clearEnvCache();
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = ORIGINAL;
  clearEnvCache();
});

describe('CORS preflight', () => {
  it('reflects any origin when CORS_ALLOWED_ORIGINS is unset (dev fallback)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization,x-tenant-id',
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      const allowedHeaders = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
      expect(allowedHeaders).toContain('authorization');
      expect(allowedHeaders).toContain('x-tenant-id');
    } finally {
      await app.close();
    }
  });

  it('allows origins on the allowlist', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.autoffice.app,https://autoffice.app';
    clearEnvCache();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'https://app.autoffice.app',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization,x-tenant-id',
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.autoffice.app');
      expect(res.headers['access-control-max-age']).toBe('600');
    } finally {
      await app.close();
    }
  });

  it('strips trailing slashes when comparing origins', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.autoffice.app/';
    clearEnvCache();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'https://app.autoffice.app',
          'access-control-request-method': 'GET',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe('https://app.autoffice.app');
    } finally {
      await app.close();
    }
  });

  it('blocks origins NOT on the allowlist', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.autoffice.app';
    clearEnvCache();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });
      // @fastify/cors omits Access-Control-Allow-Origin when origin is rejected;
      // the browser then refuses the response.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
