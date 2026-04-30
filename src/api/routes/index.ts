import type { FastifyInstance } from 'fastify';
import { agentRoutes } from './agents.js';
import { conversationRoutes } from './conversations.js';
import { credentialRoutes } from './credentials.js';
import { healthRoutes } from './health.js';
import { taskRoutes } from './tasks.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(conversationRoutes, { prefix: '/v1' });
  await app.register(taskRoutes, { prefix: '/v1' });
  await app.register(agentRoutes, { prefix: '/v1' });
  await app.register(credentialRoutes, { prefix: '/v1' });
}
