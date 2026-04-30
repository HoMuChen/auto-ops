import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ValidationError } from '../../lib/errors.js';

export function errorHandler(
  error: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof ZodError) {
    const ve = new ValidationError('Request validation failed', error.flatten());
    req.log.warn({ err: ve, path: req.url }, 'validation error');
    return reply.status(ve.statusCode).send({ error: ve.toPayload() });
  }

  if (error instanceof AppError) {
    req.log.warn({ err: error, path: req.url }, 'domain error');
    return reply.status(error.statusCode).send({ error: error.toPayload() });
  }

  // Fastify-native errors carry statusCode
  const fastifyErr = error as FastifyError;
  if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
    req.log.warn({ err: error, path: req.url }, 'client error');
    return reply.status(fastifyErr.statusCode).send({
      error: {
        code: fastifyErr.code ?? 'bad_request',
        message: fastifyErr.message,
        statusCode: fastifyErr.statusCode,
      },
    });
  }

  req.log.error({ err: error, path: req.url }, 'unhandled error');
  return reply.status(500).send({
    error: {
      code: 'internal_error',
      message: 'Internal Server Error',
      statusCode: 500,
    },
  });
}
