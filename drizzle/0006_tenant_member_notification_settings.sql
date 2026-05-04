ALTER TABLE "tenant_members"
  ADD COLUMN IF NOT EXISTS "notification_settings" jsonb;
