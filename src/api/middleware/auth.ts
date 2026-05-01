import type { FastifyReply, FastifyRequest } from 'fastify';
import { getAuthService } from '../../auth/index.js';
import type { AuthenticatedUser } from '../../auth/index.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import { UnauthorizedError } from '../../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Verify the bearer token and JIT-provision the `users` row.
 *
 * Auth is owned by Supabase; the local `users` table just mirrors the auth
 * subject so foreign-key references (tenant_members, tasks.created_by, …)
 * resolve. We upsert on every request — cheap, single-statement, conflict-
 * absorbing — to avoid the "first-time user gets a 500" failure mode.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing bearer token');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new UnauthorizedError('Empty bearer token');

  const authed = await getAuthService().verifyToken(token);
  req.user = authed;

  await db
    .insert(users)
    .values({ id: authed.id, email: authed.email })
    .onConflictDoUpdate({
      target: users.id,
      set: { email: authed.email },
    });
}
