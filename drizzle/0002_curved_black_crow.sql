CREATE TABLE "task_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_brief" text,
	"draft_title" text,
	"finalized_task_id" uuid,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_intakes" ADD CONSTRAINT "task_intakes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_intakes" ADD CONSTRAINT "task_intakes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_intakes" ADD CONSTRAINT "task_intakes_finalized_task_id_tasks_id_fk" FOREIGN KEY ("finalized_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_intakes_tenant_status_idx" ON "task_intakes" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "task_intakes_tenant_updated_idx" ON "task_intakes" USING btree ("tenant_id","updated_at");