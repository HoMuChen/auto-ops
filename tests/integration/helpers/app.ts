import type { FastifyInstance } from 'fastify';
import { bootstrapAgents } from '../../../src/agents/index.js';
import { createServer } from '../../../src/server.js';

/**
 * Build a Fastify instance for tests. Goes through the same bootstrap as
 * production, except:
 *   - We do NOT start the polling worker. Tests drive the worker manually
 *     (see helpers/runner.ts) so timing is deterministic.
 *   - bootstrapAgents() is idempotent so multiple test files calling it is fine.
 */
export async function createTestApp(): Promise<FastifyInstance> {
  bootstrapAgents();
  const app = await createServer();
  await app.ready();
  return app;
}
