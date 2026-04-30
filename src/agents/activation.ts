import { ZodError } from 'zod';
import type { CredentialProvider } from '../db/schema/index.js';
import { ConflictError, ValidationError } from '../lib/errors.js';
import type { AgentManifest } from './types.js';

export interface CredentialPresence {
  provider: CredentialProvider;
  /** Labels currently bound for this provider — empty means "not bound". */
  labels: string[];
}

export interface CredentialChecklistItem {
  provider: CredentialProvider;
  description: string;
  setupUrl?: string;
  bound: boolean;
}

/**
 * Project the manifest's credential requirements onto the tenant's current
 * credential bindings. Used by both `getActivationStatus` (for UI) and
 * `assertCredentialsBound` (for the activate endpoint).
 */
export function buildCredentialChecklist(
  manifest: AgentManifest,
  presence: CredentialPresence[],
): CredentialChecklistItem[] {
  if (!manifest.requiredCredentials) return [];
  const presenceMap = new Map<CredentialProvider, string[]>();
  for (const p of presence) presenceMap.set(p.provider, p.labels);

  return manifest.requiredCredentials.map((req) => {
    const labels = presenceMap.get(req.provider) ?? [];
    const bound = req.defaultLabel ? labels.includes(req.defaultLabel) : labels.length > 0;
    return {
      provider: req.provider,
      description: req.description,
      ...(req.setupUrl ? { setupUrl: req.setupUrl } : {}),
      bound,
    };
  });
}

/**
 * Assert every required credential is bound. Throws ConflictError listing the
 * missing providers if any are absent.
 */
export function assertCredentialsBound(
  manifest: AgentManifest,
  presence: CredentialPresence[],
): void {
  const checklist = buildCredentialChecklist(manifest, presence);
  const missing = checklist.filter((c) => !c.bound);
  if (missing.length > 0) {
    throw new ConflictError(
      `Missing required credentials: ${missing.map((m) => m.provider).join(', ')}`,
      { missing },
    );
  }
}

/**
 * Validate user-supplied config against the manifest's configSchema. Returns
 * the parsed value (with Zod defaults applied). If the manifest declares no
 * schema, returns an empty object regardless of input — callers should not
 * pass config to a schema-less agent, but we don't fail hard either.
 */
export function validateAgentConfig(
  manifest: AgentManifest,
  config: unknown,
): Record<string, unknown> {
  if (!manifest.configSchema) return {};
  try {
    return manifest.configSchema.parse(config ?? {}) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ValidationError(`Invalid config for agent ${manifest.id}`, err.flatten());
    }
    throw err;
  }
}
