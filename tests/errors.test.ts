import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  IllegalStateError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../src/lib/errors.js';

describe('AppError', () => {
  it('preserves code, message, statusCode', () => {
    const err = new AppError({ code: 'x', message: 'y', statusCode: 418 });
    expect(err.code).toBe('x');
    expect(err.message).toBe('y');
    expect(err.statusCode).toBe(418);
  });

  it('toPayload omits details when not provided', () => {
    const err = new AppError({ code: 'x', message: 'y', statusCode: 400 });
    expect(err.toPayload()).toEqual({ code: 'x', message: 'y', statusCode: 400 });
  });

  it('toPayload includes details when provided', () => {
    const err = new AppError({
      code: 'x',
      message: 'y',
      statusCode: 400,
      details: { field: 'foo' },
    });
    expect(err.toPayload()).toEqual({
      code: 'x',
      message: 'y',
      statusCode: 400,
      details: { field: 'foo' },
    });
  });

  it('is an instanceof Error', () => {
    expect(new AppError({ code: 'a', message: 'b', statusCode: 500 })).toBeInstanceOf(Error);
  });
});

describe('subclasses map to expected status codes', () => {
  it('ValidationError → 400', () => {
    expect(new ValidationError('bad').statusCode).toBe(400);
  });
  it('UnauthorizedError → 401', () => {
    expect(new UnauthorizedError().statusCode).toBe(401);
  });
  it('ForbiddenError → 403', () => {
    expect(new ForbiddenError().statusCode).toBe(403);
  });
  it('NotFoundError → 404 with formatted message', () => {
    const err = new NotFoundError('User');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('User not found');
  });
  it('ConflictError → 409', () => {
    expect(new ConflictError('dup').statusCode).toBe(409);
  });
  it('IllegalStateError → 422', () => {
    expect(new IllegalStateError('nope').statusCode).toBe(422);
  });
  it('ExternalServiceError → 502 with namespaced code', () => {
    const err = new ExternalServiceError('shopify', 'down');
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe('external_shopify_error');
  });
});
