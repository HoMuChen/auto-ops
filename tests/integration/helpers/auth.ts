import { SignJWT } from 'jose';
import { env } from '../../../src/config/env.js';

const key = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

/**
 * Mint a JWT signed with the Supabase JWT secret — matches what
 * `SupabaseAuthService` expects so `requireAuth` will accept it.
 *
 * This intentionally bypasses Supabase's GoTrue endpoint: integration tests
 * shouldn't depend on creating real auth users via HTTP.
 */
export async function mintJwt(opts: {
  userId: string;
  email: string;
  expiresIn?: string;
}): Promise<string> {
  return new SignJWT({ sub: opts.userId, email: opts.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(key);
}

export function authHeaders(token: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenantId) headers['x-tenant-id'] = tenantId;
  return headers;
}
