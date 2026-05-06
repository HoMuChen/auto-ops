import { z } from 'zod';
import { logger } from '../../lib/logger.js';

/**
 * Lenient schema helpers for fields where strict validation is more trouble
 * than it's worth — usually optional metadata that the model occasionally
 * emits in slightly-off shapes.
 *
 * The general idea: combine `.transform()` (for normalization) with
 * `.catch(default)` (for graceful fallback on totally bad input). The
 * fallback path logs at warn so a quality regression in model output is
 * still visible in dev logs even though it doesn't break the run.
 */

const datetimeFallback = (input: unknown): null => {
  logger.warn(
    { component: 'lenient-schemas', field: 'flexibleDatetime', input },
    'flexibleDatetime: input failed validation, falling back to null',
  );
  return null;
};

/**
 * Optional ISO 8601 timestamp that accepts:
 *   - Strict ISO with `Z` or `±HH:mm` offset (canonical case)
 *   - Loose forms parseable by `new Date(...)` (e.g. "2026-05-06",
 *     "2026/05/06 09:00", "May 6 2026 09:00 +0800")
 *   - null / undefined / "" → treated as "no schedule"
 *   - Any non-string garbage → falls back to null instead of rejecting
 *
 * Always normalizes a parseable value to canonical UTC ISO. Output is
 * `string | null` — never throws, never returns undefined.
 *
 * Used by strategy agents (seo-strategist, product-planner) where Sonnet
 * naturally emits `+08:00`-form timestamps for zh-TW briefs and where an
 * unschedulable value just means "run immediately" rather than a hard
 * error worth burning a tool-loop hop on.
 *
 * Implementation note: we deliberately avoid `z.preprocess` because its
 * output type doesn't propagate cleanly through `z.infer<typeof Parent>`
 * — the field shows up as `unknown` in the parent's inferred type, which
 * breaks downstream consumers (e.g. SpawnTaskRequest typing).
 */
export const flexibleDatetime = z.unknown().transform((v): string | null => {
  if (v == null) return null;
  if (typeof v !== 'string') {
    datetimeFallback(v);
    return null;
  }
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    datetimeFallback(v);
    return null;
  }
  return d.toISOString();
});
