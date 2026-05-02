CREATE TABLE "tenant_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cf_image_id" text NOT NULL,
	"url" text NOT NULL,
	"source_type" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"prompt" text,
	"source_image_id" uuid,
	"task_id" uuid,
	"mime_type" text,
	"file_size" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_images" ADD CONSTRAINT "tenant_images_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_images" ADD CONSTRAINT "tenant_images_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_images" ADD CONSTRAINT "tenant_images_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_images_tenant_created_idx" ON "tenant_images" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "tenant_images_task_idx" ON "tenant_images" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tenant_images_source_idx" ON "tenant_images" USING btree ("source_image_id");