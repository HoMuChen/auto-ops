import { z } from 'zod';

/**
 * Shared schema for the per-agent `skills` config field. Each key is a
 * built-in pack id (frontmatter `key`); value is on/off. Open record because
 * built-in pack keys are decided in code at each agent dir, not centrally.
 *
 * User-supplied tenant skill packs are NOT toggled here — their activation
 * lives in `tenant_skill_packs.applies_to`.
 */
export const skillsToggleSchema = z.record(z.string(), z.boolean()).default({});
export type SkillsToggle = z.infer<typeof skillsToggleSchema>;
