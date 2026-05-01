import { describe, expect, it } from 'vitest';
import {
  ApproveBody,
  CreateTaskBody,
  ErrorEnvelope,
  FeedbackBody,
  PaginationQuery,
  TaskStatusSchema,
} from '../src/api/schemas.js';

describe('TaskStatusSchema', () => {
  it.each(['todo', 'in_progress', 'waiting', 'done', 'failed'] as const)('accepts %s', (s) => {
    expect(TaskStatusSchema.parse(s)).toBe(s);
  });

  it('rejects unknown statuses', () => {
    expect(() => TaskStatusSchema.parse('paused')).toThrow();
  });
});

describe('CreateTaskBody', () => {
  it('requires brief', () => {
    expect(() => CreateTaskBody.parse({})).toThrow();
  });

  it('rejects empty brief', () => {
    expect(() => CreateTaskBody.parse({ brief: '' })).toThrow();
  });

  it('accepts brief alone', () => {
    expect(CreateTaskBody.parse({ brief: 'plan summer SEO' })).toMatchObject({
      brief: 'plan summer SEO',
    });
  });

  it('accepts optional preferredAgent / params / scheduledAt', () => {
    const result = CreateTaskBody.parse({
      brief: 'do thing',
      preferredAgent: 'seo-expert',
      params: { language: 'zh-TW' },
      scheduledAt: '2026-05-01T00:00:00.000Z',
    });
    expect(result.preferredAgent).toBe('seo-expert');
    expect(result.params).toEqual({ language: 'zh-TW' });
    expect(result.scheduledAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('rejects malformed scheduledAt', () => {
    expect(() => CreateTaskBody.parse({ brief: 'x', scheduledAt: 'tomorrow' })).toThrow();
  });
});

describe('FeedbackBody', () => {
  it('requires non-empty feedback', () => {
    expect(() => FeedbackBody.parse({ feedback: '' })).toThrow();
    expect(() => FeedbackBody.parse({})).toThrow();
  });

  it('accepts a feedback string', () => {
    expect(FeedbackBody.parse({ feedback: 'tone too formal' })).toEqual({
      feedback: 'tone too formal',
    });
  });
});

describe('ApproveBody', () => {
  it('accepts undefined / empty body', () => {
    expect(ApproveBody.parse(undefined)).toBeUndefined();
    expect(ApproveBody.parse({})).toEqual({});
  });

  it('accepts { finalize: true }', () => {
    expect(ApproveBody.parse({ finalize: true })).toEqual({ finalize: true });
  });
});

describe('PaginationQuery', () => {
  it('accepts empty query', () => {
    expect(PaginationQuery.parse({})).toEqual({});
  });

  it('rejects invalid status', () => {
    expect(() => PaginationQuery.parse({ status: 'paused' })).toThrow();
  });

  it('rejects non-uuid parentTaskId', () => {
    expect(() => PaginationQuery.parse({ parentTaskId: 'abc' })).toThrow();
  });
});

describe('ErrorEnvelope', () => {
  it('matches the shape produced by AppError.toPayload()', () => {
    expect(
      ErrorEnvelope.parse({
        error: { code: 'not_found', message: 'x', statusCode: 404 },
      }),
    ).toBeDefined();
  });

  it('rejects payloads missing the error wrapper', () => {
    expect(() => ErrorEnvelope.parse({ code: 'x' })).toThrow();
  });
});
