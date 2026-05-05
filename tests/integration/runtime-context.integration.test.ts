import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { tenants } from '../../src/db/schema/index.js';
import { buildRuntimeContext } from '../../src/orchestrator/runtime-context.js';

describe('buildRuntimeContext (integration)', () => {
  let tenantId: string;

  beforeAll(async () => {
    const [t] = await db
      .insert(tenants)
      .values({
        name: 'Tester',
        slug: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        profileMd: '## Voice\n\nWarm and direct.',
        timezone: 'Asia/Taipei',
      })
      .returning();
    tenantId = t!.id;
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('emits Runtime context block with timezone, current time, and profile', async () => {
    const block = await buildRuntimeContext(tenantId);
    expect(block.startsWith('Runtime context:')).toBe(true);
    expect(block).toMatch(/- Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(block).toContain('- Tenant timezone: Asia/Taipei');
    expect(block).toContain('## Tenant profile');
    expect(block).toContain('Warm and direct.');
    expect(block.endsWith('---\n\n')).toBe(true);
  });

  it('omits the profile section when profile_md is empty', async () => {
    const [empty] = await db
      .insert(tenants)
      .values({
        name: 'Empty',
        slug: `empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      .returning();
    try {
      const block = await buildRuntimeContext(empty!.id);
      expect(block).not.toContain('## Tenant profile');
      expect(block).toContain('- Tenant timezone: UTC');
    } finally {
      await db.delete(tenants).where(eq(tenants.id, empty!.id));
    }
  });

  it('throws NotFoundError when the tenant row is missing', async () => {
    await expect(
      buildRuntimeContext('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/Tenant 00000000-0000-0000-0000-000000000000/);
  });
});
