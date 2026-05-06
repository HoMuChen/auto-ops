import { describe, expect, it } from 'vitest';
import { flexibleDatetime } from '../src/agents/lib/lenient-schemas.js';

describe('flexibleDatetime', () => {
  it('accepts strict UTC ISO and normalizes to canonical', () => {
    const r = flexibleDatetime.parse('2026-05-04T09:00:00Z');
    expect(r).toBe('2026-05-04T09:00:00.000Z');
  });

  it('accepts ISO with +HH:MM offset (the bug that triggered this helper)', () => {
    const r = flexibleDatetime.parse('2026-05-06T09:00:00+08:00');
    // +08:00 09:00 = UTC 01:00
    expect(r).toBe('2026-05-06T01:00:00.000Z');
  });

  it('accepts loose date-only form via Date parser', () => {
    const r = flexibleDatetime.parse('2026-05-06');
    expect(r).toMatch(/^2026-05-06T/);
  });

  it('returns null for null / undefined / empty string', () => {
    expect(flexibleDatetime.parse(null)).toBeNull();
    expect(flexibleDatetime.parse(undefined)).toBeNull();
    expect(flexibleDatetime.parse('')).toBeNull();
    expect(flexibleDatetime.parse('   ')).toBeNull();
  });

  it('returns null for unparseable garbage instead of throwing', () => {
    expect(flexibleDatetime.parse('not a date')).toBeNull();
    expect(flexibleDatetime.parse('💩')).toBeNull();
  });

  it('returns null for non-string input instead of throwing', () => {
    expect(flexibleDatetime.parse(12345)).toBeNull();
    expect(flexibleDatetime.parse({})).toBeNull();
    expect(flexibleDatetime.parse([])).toBeNull();
    expect(flexibleDatetime.parse(true)).toBeNull();
  });
});
