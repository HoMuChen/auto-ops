CREATE TABLE "user_stream_cursors" (
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tenant_id"  uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "cursor_at"  timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "tenant_id")
);
