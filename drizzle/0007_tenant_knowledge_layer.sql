-- Layer 1: tenant profile fields. Idempotent — re-runnable on every db:migrate.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS profile_md TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone   TEXT NOT NULL DEFAULT 'UTC';

-- Carry forward orphan brand_voice content (if column still exists from before
-- this migration ran). Guarded so subsequent runs are no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'brand_voice'
  ) THEN
    EXECUTE $u$
      UPDATE tenants
      SET profile_md =
        '## Brand voice (migrated)' || E'\n\n' ||
        'Tone: ' || COALESCE(brand_voice->>'tone', '(unspecified)') || E'\n' ||
        'Languages: ' || COALESCE((brand_voice->'languages')::text, '[]') || E'\n' ||
        'Preferred keywords: ' || COALESCE((brand_voice->'keywords')::text, '[]') || E'\n' ||
        'Forbidden phrases: ' || COALESCE((brand_voice->'forbidden')::text, '[]') || E'\n'
      WHERE brand_voice IS NOT NULL AND profile_md = ''
    $u$;
    EXECUTE 'ALTER TABLE tenants DROP COLUMN brand_voice';
  END IF;
END $$;

-- Layer 2: skill packs.
CREATE TABLE IF NOT EXISTS tenant_skill_packs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  applies_to  TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT  tenant_skill_packs_tenant_key_uq UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS tenant_skill_packs_tenant_idx
  ON tenant_skill_packs (tenant_id);
CREATE INDEX IF NOT EXISTS tenant_skill_packs_applies_to_gin
  ON tenant_skill_packs USING GIN (applies_to);
