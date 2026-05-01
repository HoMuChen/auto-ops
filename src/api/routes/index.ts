import type { FastifyInstance } from 'fastify';
import { agentRoutes } from './agents.js';
import { credentialRoutes } from './credentials.js';
import { healthRoutes } from './health.js';
import { meRoutes } from './me.js';
import { taskRoutes } from './tasks.js';
import { tenantRoutes } from './tenants.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(tenantRoutes, { prefix: '/v1' });
  await app.register(taskRoutes, { prefix: '/v1' });
  await app.register(agentRoutes, { prefix: '/v1' });
  await app.register(credentialRoutes, { prefix: '/v1' });
}
