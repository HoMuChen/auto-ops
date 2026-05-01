import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../lib/errors.js';
import type { AuthService, AuthenticatedUser } from './auth.types.js';

/**
 * Supabase JWT verifier.
 *
 * Modern Supabase (CLI v2 + projects with asymmetric signing keys) issues
 * access tokens signed with ES256 and publishes the public keys at
 * `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. That is the default path.
 *
 * For projects still on the legacy HS256 shared-secret model — and for
 * integration tests that mint their own tokens — we also accept HS256 when
 * `SUPABASE_JWT_SECRET` is configured. The verifier branches on the JWT
 * `alg` header so a single instance can validate both.
 *
 * We deliberately use `jose` (not @supabase/supabase-js) so business code
 * doesn't depend on Supabase SDK semantics. To swap providers, implement
 * AuthService with the new provider's verification logic.
 */
export interface SupabaseAuthOptions {
  /** Optional shared secret for HS256 tokens (legacy / tests). */
  hsSecret?: string;
  /** Supabase project URL — used to build the JWKS endpoint. */
  supabaseUrl?: string;
}

export class SupabaseAuthService implements AuthService {
  private readonly hsSecret: Uint8Array | null;
  private readonly jwks: JWTVerifyGetKey | null;

  constructor(opts: SupabaseAuthOptions | string = {}) {
    // Back-compat: allow `new SupabaseAuthService(secret)` (used by unit tests).
    const config: SupabaseAuthOptions = typeof opts === 'string' ? { hsSecret: opts } : opts;

    const hs = config.hsSecret ?? env.SUPABASE_JWT_SECRET;
    this.hsSecret = hs ? new TextEncoder().encode(hs) : null;

    const url = config.supabaseUrl ?? env.SUPABASE_URL;
    this.jwks = url ? createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', url)) : null;
  }

  async verifyToken(token: string): Promise<AuthenticatedUser> {
    try {
      const alg = readAlg(token);
      const payload = await this.verifyByAlg(token, alg);

      const sub = typeof payload.sub === 'string' ? payload.sub : null;
      const email = typeof payload.email === 'string' ? payload.email : null;
      if (!sub || !email) {
        throw new UnauthorizedError('Token missing subject or email');
      }
      return { id: sub, email, claims: payload };
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      throw new UnauthorizedError('Invalid or expired token');
    }
  }

  private async verifyByAlg(token: string, alg: string): Promise<Record<string, unknown>> {
    if (alg === 'HS256') {
      if (!this.hsSecret) {
        throw new UnauthorizedError('HS256 token rejected: SUPABASE_JWT_SECRET not configured');
      }
      const { payload } = await jwtVerify(token, this.hsSecret, { algorithms: ['HS256'] });
      return payload as Record<string, unknown>;
    }

    if (!this.jwks) {
      throw new UnauthorizedError('Asymmetric token rejected: SUPABASE_URL not configured');
    }
    const { payload } = await jwtVerify(token, this.jwks, {
      algorithms: ['ES256', 'RS256'],
    });
    return payload as Record<string, unknown>;
  }
}

function readAlg(token: string): string {
  const dot = token.indexOf('.');
  if (dot <= 0) return '';
  try {
    const headerJson = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    const header = JSON.parse(headerJson) as { alg?: unknown };
    return typeof header.alg === 'string' ? header.alg : '';
  } catch {
    return '';
  }
}
