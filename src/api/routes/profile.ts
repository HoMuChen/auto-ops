import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { tenantImages } from '../../db/schema/index.js';
import { ValidationError } from '../../lib/errors.js';
import { buildModel } from '../../llm/model-registry.js';
import { getTenantProfile, updateTenantProfile } from '../../tenants/profile-repository.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, tenantOf } from '../middleware/tenant.js';

const PROFILE_MD_MAX = 32 * 1024;
const STYLE_SUFFIX_MAX = 2 * 1024;
const MAX_REFERENCE_IMAGES = 5;
const validTimezones = new Set(Intl.supportedValuesOf('timeZone'));

const ProfileResponse = z.object({
  profileMd: z.string(),
  timezone: z.string(),
  imageStyleSuffix: z.string(),
  imageStyleReferenceImageIds: z.array(z.string().uuid()),
});

const UpdateProfileBody = z.object({
  profileMd: z.string().max(PROFILE_MD_MAX).optional(),
  timezone: z
    .string()
    .refine((tz) => validTimezones.has(tz), 'invalid IANA timezone')
    .optional(),
  imageStyleSuffix: z.string().max(STYLE_SUFFIX_MAX).optional(),
  imageStyleReferenceImageIds: z.array(z.string().uuid()).max(MAX_REFERENCE_IMAGES).optional(),
});

const SuggestBody = z.object({
  referenceImageIds: z.array(z.string().uuid()).min(1).max(MAX_REFERENCE_IMAGES),
  hint: z.string().max(500).optional(),
});

const SuggestResponse = z.object({
  suggestedSuffix: z.string(),
});

const SuffixSchema = z.object({
  suffix: z.string().min(20).max(2000),
});

const VISION_SYSTEM_PROMPT =
  "You extract visual style guidelines from a brand's reference images. Output ONE dense prose paragraph (80–200 words) capturing: photography genre (editorial / product / lifestyle / studio), lighting (direction, quality), color palette and mood, composition rules (centered / rule-of-thirds / copy space), background, props and models, finish (clean / film grain). The output will be appended verbatim to image-generation prompts — write it as instructions to an image model. No headings, no bullets, no quote marks. One paragraph only.";

/**
 * Confirms every id is owned by the tenant and returns the rows (with `url`).
 * Throws ValidationError listing offending ids if any are missing or foreign.
 */
async function fetchOwnedReferenceImages(
  tenantId: string,
  ids: string[],
): Promise<{ id: string; url: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: tenantImages.id, url: tenantImages.url })
    .from(tenantImages)
    .where(and(eq(tenantImages.tenantId, tenantId), inArray(tenantImages.id, ids)));
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new ValidationError(`Reference image ids not owned by tenant: ${missing.join(', ')}`);
  }
  return rows;
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/profile',
    {
      schema: {
        tags: ['tenants'],
        response: { 200: ProfileResponse },
      },
    },
    async (req) => getTenantProfile(tenantOf(req)),
  );

  app.put(
    '/profile',
    {
      schema: {
        tags: ['tenants'],
        body: UpdateProfileBody,
        response: { 200: ProfileResponse },
      },
    },
    async (req) => {
      const body = req.body as z.infer<typeof UpdateProfileBody>;
      if (body.imageStyleReferenceImageIds) {
        await fetchOwnedReferenceImages(tenantOf(req), body.imageStyleReferenceImageIds);
      }
      return updateTenantProfile(tenantOf(req), body);
    },
  );

  app.post(
    '/profile/image-style/suggest',
    {
      schema: {
        tags: ['tenants'],
        body: SuggestBody,
        response: { 200: SuggestResponse },
      },
    },
    async (req) => {
      const tenantId = tenantOf(req);
      const body = req.body as z.infer<typeof SuggestBody>;

      const rows = await fetchOwnedReferenceImages(tenantId, body.referenceImageIds);

      const model = buildModel({
        model: 'anthropic/claude-sonnet-4.6',
        temperature: 0.2,
      }).withStructuredOutput(SuffixSchema, { name: 'image_style_suffix' });

      const userContent: Array<
        { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
      > = [
        { type: 'text', text: body.hint ?? 'Describe the visual style.' },
        ...rows.map((r) => ({
          type: 'image_url' as const,
          image_url: { url: r.url },
        })),
      ];

      const { HumanMessage, SystemMessage } = await import('@langchain/core/messages');
      const result = await model.invoke([
        new SystemMessage(VISION_SYSTEM_PROMPT),
        new HumanMessage({ content: userContent }),
      ]);

      return { suggestedSuffix: result.suffix };
    },
  );
}
