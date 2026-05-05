import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPacks } from '../../src/agents/lib/packs.js';
import { db } from '../../src/db/client.js';
import { tenantSkillPacks, tenants } from '../../src/db/schema/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, '../fixtures/packs');

describe('loadPacks (with tenant DB packs)', () => {
  let tenantId: string;

  beforeEach(async () => {
    const [t] = await db
      .insert(tenants)
      .values({ name: 'T', slug: `lp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
      .returning();
    tenantId = t!.id;
  });

  afterEach(async () => {
    await db.delete(tenantSkillPacks).where(eq(tenantSkillPacks.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('includes tenant pack scoped to the calling agent', async () => {
    await db.insert(tenantSkillPacks).values({
      tenantId,
      key: 'tenant.brand-guide',
      name: 'Brand Guide',
      body: '## Voice\n\nWarm.',
      appliesTo: ['shopify-blog-writer'],
    });

    const out = await loadPacks({
      builtInDir: dir,
      builtInEnabled: { seoFundamentals: true },
      tenantId,
      agentId: 'shopify-blog-writer',
    });

    expect(out).toMatch(/## Skill: SEO Fundamentals/); // built-in first
    expect(out).toMatch(/## Skill: Brand Guide/); // tenant after
    expect(out.indexOf('SEO Fundamentals')).toBeLessThan(out.indexOf('Brand Guide'));
  });

  it('excludes tenant pack whose applies_to does not include the calling agent', async () => {
    await db.insert(tenantSkillPacks).values({
      tenantId,
      key: 'tenant.x',
      name: 'X',
      body: 'irrelevant',
      appliesTo: ['seo-strategist'],
    });
    const out = await loadPacks({
      builtInDir: dir,
      builtInEnabled: {},
      tenantId,
      agentId: 'shopify-blog-writer',
    });
    expect(out).toBe('');
  });
});
