import { jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../lib/errors.js';
import type { AuthService, AuthenticatedUser } from './auth.types.js';

/**
 * Supabase JWT verifier — uses the project's HS256 JWT secret.
 *
 * We deliberately use `jose` (not @supabase/supabase-js) so business code
 * doesn't depend on Supabase SDK semantics. To swap providers, implement
 * AuthService with the new provider's verification logic.
 */
export class SupabaseAuthService implements AuthService {
  private readonly secret: Uint8Array;

  constructor(jwtSecret: string = env.SUPABASE_JWT_SECRET) {
    this.secret = new TextEncoder().encode(jwtSecret);
  }

  async verifyToken(token: string): Promise<AuthenticatedUser> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        algorithms: ['HS256'],
      });
      const sub = typeof payload.sub === 'string' ? payload.sub : null;
      const email = typeof payload.email === 'string' ? payload.email : null;
      if (!sub || !email) {
        throw new UnauthorizedError('Token missing subject or email');
      }
      return { id: sub, email, claims: payload as Record<string, unknown> };
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      throw new UnauthorizedError('Invalid or expired token');
    }
  }
}
