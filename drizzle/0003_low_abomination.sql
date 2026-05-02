CREATE TABLE "serp_cache" (
	"tenant_id" uuid NOT NULL,
	"query_hash" text NOT NULL,
	"locale" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "serp_cache_tenant_id_query_hash_locale_pk" PRIMARY KEY("tenant_id","query_hash","locale")
);
--> statement-breakpoint
ALTER TABLE "serp_cache" ADD CONSTRAINT "serp_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;