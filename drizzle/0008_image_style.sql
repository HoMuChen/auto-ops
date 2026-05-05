-- Tenant-level image style fields. Idempotent — re-runnable on every db:migrate.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS image_style_suffix TEXT NOT NULL DEFAULT '';

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS image_style_reference_image_ids UUID[] NOT NULL DEFAULT '{}';
