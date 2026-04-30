import type { FastifyReply, FastifyRequest } from 'fastify';
import { getAuthService } from '../../auth/index.js';
import type { AuthenticatedUser } from '../../auth/index.js';
import { UnauthorizedError } from '../../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing bearer token');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new UnauthorizedError('Empty bearer token');
  req.user = await getAuthService().verifyToken(token);
}
