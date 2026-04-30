import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type CredentialPresence,
  assertCredentialsBound,
  buildCredentialChecklist,
  validateAgentConfig,
} from '../src/agents/activation.js';
import type { AgentManifest } from '../src/agents/types.js';
import { ConflictError, ValidationError } from '../src/lib/errors.js';

function manifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    description: 'unit test agent',
    availableInPlans: ['basic'],
    defaultModel: { model: 'anthropic/fake' },
    defaultPrompt: 'fake',
    ...overrides,
  };
}

describe('buildCredentialChecklist', () => {
  it('returns empty list when manifest has no requiredCredentials', () => {
    expect(buildCredentialChecklist(manifest(), [])).toEqual([]);
  });

  it('marks credential as bound when at least one row exists for the provider', () => {
    const m = manifest({
      requiredCredentials: [{ provider: 'shopify', description: 'Shopify token' }],
    });
    const presence: CredentialPresence[] = [{ provider: 'shopify', labels: [''] }];
    expect(buildCredentialChecklist(m, presence)).toEqual([
      { provider: 'shopify', description: 'Shopify token', bound: true },
    ]);
  });

  it('marks as not bound when provider missing entirely', () => {
    const m = manifest({
      requiredCredentials: [{ provider: 'shopify', description: 'Shopify token' }],
    });
    expect(buildCredentialChecklist(m, [])).toEqual([
      { provider: 'shopify', description: 'Shopify token', bound: false },
    ]);
  });

  it('honors defaultLabel when set', () => {
    const m = manifest({
      requiredCredentials: [
        {
          provider: 'shopify',
          description: 'Shopify token',
          defaultLabel: 'main-store',
        },
      ],
    });
    const presence: CredentialPresence[] = [{ provider: 'shopify', labels: ['secondary-store'] }];
    expect(buildCredentialChecklist(m, presence)[0]?.bound).toBe(false);

    presence[0]!.labels.push('main-store');
    expect(buildCredentialChecklist(m, presence)[0]?.bound).toBe(true);
  });

  it('passes through setupUrl when present', () => {
    const m = manifest({
      requiredCredentials: [
        {
          provider: 'shopify',
          description: 'doc',
          setupUrl: 'https://example.com/setup',
        },
      ],
    });
    expect(buildCredentialChecklist(m, [])).toEqual([
      {
        provider: 'shopify',
        description: 'doc',
        setupUrl: 'https://example.com/setup',
        bound: false,
      },
    ]);
  });
});

describe('assertCredentialsBound', () => {
  it('does not throw when nothing required', () => {
    expect(() => assertCredentialsBound(manifest(), [])).not.toThrow();
  });

  it('does not throw when all required credentials are bound', () => {
    const m = manifest({
      requiredCredentials: [{ provider: 'shopify', description: 'x' }],
    });
    const presence: CredentialPresence[] = [{ provider: 'shopify', labels: [''] }];
    expect(() => assertCredentialsBound(m, presence)).not.toThrow();
  });

  it('throws ConflictError listing missing providers', () => {
    const m = manifest({
      requiredCredentials: [
        { provider: 'shopify', description: 'A' },
        { provider: 'instagram', description: 'B' },
      ],
    });
    const presence: CredentialPresence[] = [{ provider: 'shopify', labels: [''] }];

    try {
      assertCredentialsBound(m, presence);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toMatch(/instagram/);
      const details = (err as ConflictError).details as { missing: { provider: string }[] };
      expect(details.missing.map((m) => m.provider)).toEqual(['instagram']);
    }
  });
});

describe('validateAgentConfig', () => {
  it('returns {} when manifest has no schema', () => {
    expect(validateAgentConfig(manifest(), { foo: 'bar' })).toEqual({});
  });

  it('parses through schema, applying defaults', () => {
    const m = manifest({
      configSchema: z.object({
        autoPublish: z.boolean().default(false),
        vendor: z.string().optional(),
      }),
    });
    expect(validateAgentConfig(m, {})).toEqual({ autoPublish: false });
    expect(validateAgentConfig(m, { autoPublish: true })).toEqual({ autoPublish: true });
  });

  it('throws ValidationError on schema mismatch with flattened details', () => {
    const m = manifest({
      configSchema: z.object({
        listId: z.string(),
        from: z.string().email(),
      }),
    });
    try {
      validateAgentConfig(m, { listId: 'x', from: 'not-an-email' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const details = (err as ValidationError).details as {
        fieldErrors: Record<string, string[] | undefined>;
      };
      expect(details.fieldErrors.from).toBeDefined();
    }
  });

  it('handles null/undefined config by parsing as empty object', () => {
    const m = manifest({
      configSchema: z.object({
        targetLanguages: z.array(z.string()).default(['zh-TW']),
      }),
    });
    expect(validateAgentConfig(m, undefined)).toEqual({ targetLanguages: ['zh-TW'] });
    expect(validateAgentConfig(m, null)).toEqual({ targetLanguages: ['zh-TW'] });
  });
});

describe('builtin agent manifests', () => {
  it('Ops Assistant configSchema accepts default empty object', async () => {
    const { opsAssistantAgent } = await import('../src/agents/builtin/ops-assistant/index.js');
    const result = validateAgentConfig(opsAssistantAgent.manifest, {});
    expect(result).toMatchObject({
      shopify: { autoPublish: false },
      defaultLanguage: 'zh-TW',
    });
  });

  it('SEO Expert configSchema accepts default empty object', async () => {
    const { seoExpertAgent } = await import('../src/agents/builtin/seo-expert/index.js');
    const result = validateAgentConfig(seoExpertAgent.manifest, {});
    expect(result).toMatchObject({
      targetLanguages: ['zh-TW'],
      bannedPhrases: [],
      preferredKeywords: [],
    });
  });

  it('SEO Expert rejects empty targetLanguages array', async () => {
    const { seoExpertAgent } = await import('../src/agents/builtin/seo-expert/index.js');
    expect(() => validateAgentConfig(seoExpertAgent.manifest, { targetLanguages: [] })).toThrow(
      ValidationError,
    );
  });
});
