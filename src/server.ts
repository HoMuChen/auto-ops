import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  type ZodTypeProvider,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { errorHandler } from './api/middleware/error.js';
import { registerRoutes } from './api/routes/index.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

function parseCorsOrigins(): boolean | string[] {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (!raw) return true;
  const list = raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return list.length > 0 ? list : true;
}

export async function createServer(): Promise<FastifyInstance> {
  const baseApp = Fastify({
    // pino's Logger satisfies the runtime contract Fastify expects, but the
    // declared FastifyBaseLogger interface requires `msgPrefix` which pino does
    // not expose. Cast through `unknown` to satisfy the structural type check.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  baseApp.setValidatorCompiler(validatorCompiler);
  baseApp.setSerializerCompiler(serializerCompiler);
  baseApp.setErrorHandler(errorHandler);

  await baseApp.register(helmet, { contentSecurityPolicy: false });
  await baseApp.register(cors, {
    origin: parseCorsOrigins(),
    allowedHeaders: ['authorization', 'content-type', 'x-tenant-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
  await baseApp.register(sensible);
  await baseApp.register(multipart);

  await baseApp.register(swagger, {
    openapi: {
      info: {
        title: 'auto-ops API',
        version: '0.1.0',
        description: 'AI e-commerce auto-operation platform',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await baseApp.register(swaggerUi, { routePrefix: '/docs' });

  await registerRoutes(baseApp);
  return baseApp.withTypeProvider<ZodTypeProvider>();
}
