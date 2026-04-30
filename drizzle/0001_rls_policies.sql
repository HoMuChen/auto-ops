-- Defense-in-depth RLS policies.
-- Application code is the primary enforcement point (see src/db/tenant-context.ts).
-- These policies act as a safety net so a buggy query cannot leak across tenants.
--
-- Strategy: every tenant-scoped table requires `app.tenant_id` to be set on the
-- session. The application sets this with `SET LOCAL app.tenant_id = $1` inside
-- a transaction, scoped per request. If unset, all reads/writes are denied.
--
-- Run this AFTER drizzle-kit generates the table migrations.

-- Helper: read current tenant id from session (returns NULL if unset)
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Enable RLS on tenant-scoped tables
ALTER TABLE tenant_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Generic policies (one per table)
CREATE POLICY tenant_isolation ON tenant_credentials
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON agent_configs
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON tasks
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON task_logs
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- A privileged role for the worker / system jobs that legitimately cross tenants
-- (e.g. the polling loop, billing rollups). Grant BYPASSRLS only to this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_ops_worker') THEN
    CREATE ROLE auto_ops_worker NOLOGIN;
  END IF;
END $$;
ALTER ROLE auto_ops_worker BYPASSRLS;
