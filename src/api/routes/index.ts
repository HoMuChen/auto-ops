import type { FastifyInstance } from 'fastify';
import { agentRoutes } from './agents.js';
import { credentialRoutes } from './credentials.js';
import { healthRoutes } from './health.js';
import { intakeRoutes } from './intakes.js';
import { meRoutes } from './me.js';
import { profileRoutes } from './profile.js';
import { skillPacksRoutes } from './skill-packs.js';
import { taskRoutes } from './tasks.js';
import { tenantRoutes } from './tenants.js';
import { uploadRoutes } from './uploads.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(tenantRoutes, { prefix: '/v1' });
  await app.register(profileRoutes, { prefix: '/v1' });
  await app.register(taskRoutes, { prefix: '/v1' });
  await app.register(intakeRoutes, { prefix: '/v1' });
  await app.register(agentRoutes, { prefix: '/v1' });
  await app.register(credentialRoutes, { prefix: '/v1' });
  await app.register(uploadRoutes, { prefix: '/v1' });
  await app.register(skillPacksRoutes, { prefix: '/v1' });
}
