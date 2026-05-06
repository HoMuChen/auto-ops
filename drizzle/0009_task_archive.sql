-- Soft-archive flag for tasks. Hides from listTasks + claimNextTask.
-- Idempotent — re-runnable on every db:migrate.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
