import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPacks } from '../src/agents/lib/packs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, 'fixtures/packs');

describe('loadPacks', () => {
  it('includes only enabled packs and renders them with versioned headings', async () => {
    const out = await loadPacks(dir, { seoFundamentals: true, eeat: true, disabled: false });
    expect(out).toMatch(/## Skill: SEO Fundamentals \(v1\)/);
    expect(out).toMatch(/## Skill: EEAT Discipline \(v2\)/);
    expect(out).not.toMatch(/disabled/i);
  });

  it('returns empty string when nothing enabled', async () => {
    const out = await loadPacks(dir, { seoFundamentals: false, eeat: false });
    expect(out).toBe('');
  });
});
