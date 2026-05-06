/**
 * Domain error hierarchy.
 *
 * Each error carries a stable `code` for client-side handling and a `statusCode`
 * for HTTP mapping. The Fastify error handler in api/middleware/error.ts maps
 * these to JSON responses.
 */

export type ErrorPayload = {
  code: string;
  message: string;
  statusCode: number;
  details?: unknown;
};

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(opts: { code: string; message: string; statusCode: number; details?: unknown }) {
    super(opts.message);
    this.name = this.constructor.name;
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.details = opts.details;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'validation_error', message, statusCode: 400, details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super({ code: 'unauthorized', message, statusCode: 401 });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details?: unknown) {
    super({ code: 'forbidden', message, statusCode: 403, details });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super({ code: 'not_found', message: `${resource} not found`, statusCode: 404 });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'conflict', message, statusCode: 409, details });
  }
}

export class IllegalStateError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'illegal_state', message, statusCode: 422, details });
  }
}

/**
 * Thrown when a worker tries to mutate a task it no longer owns. Happens when
 * the heartbeat fails long enough for `reclaimExpiredLocks` to release the
 * lock and another worker re-claims the task. The original runner catches
 * this and abandons silently — its parallel sibling is now the source of truth.
 */
export class LockLostError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'lock_lost', message, statusCode: 409, details });
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, message: string, details?: unknown) {
    super({
      code: `external_${service}_error`,
      message,
      statusCode: 502,
      details,
    });
  }
}
