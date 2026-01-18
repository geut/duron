CREATE TABLE "duron"."metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"job_id" uuid NOT NULL,
	"step_id" uuid,
	"name" text NOT NULL,
	"value" double precision NOT NULL,
	"attributes" jsonb DEFAULT '{}' NOT NULL,
	"type" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_type_check" CHECK ("type" IN ('metric', 'span_event', 'span_attribute'))
);
--> statement-breakpoint
CREATE INDEX "idx_metrics_job_id" ON "duron"."metrics" ("job_id");--> statement-breakpoint
CREATE INDEX "idx_metrics_step_id" ON "duron"."metrics" ("step_id");--> statement-breakpoint
CREATE INDEX "idx_metrics_name" ON "duron"."metrics" ("name");--> statement-breakpoint
CREATE INDEX "idx_metrics_type" ON "duron"."metrics" ("type");--> statement-breakpoint
CREATE INDEX "idx_metrics_timestamp" ON "duron"."metrics" ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_metrics_job_step" ON "duron"."metrics" ("job_id","step_id");--> statement-breakpoint
CREATE INDEX "idx_metrics_job_name" ON "duron"."metrics" ("job_id","name");--> statement-breakpoint
CREATE INDEX "idx_metrics_job_type" ON "duron"."metrics" ("job_id","type");--> statement-breakpoint
CREATE INDEX "idx_metrics_attributes" ON "duron"."metrics" USING gin ("attributes");--> statement-breakpoint
ALTER TABLE "duron"."metrics" ADD CONSTRAINT "metrics_job_id_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "duron"."jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "duron"."metrics" ADD CONSTRAINT "metrics_step_id_job_steps_id_fkey" FOREIGN KEY ("step_id") REFERENCES "duron"."job_steps"("id") ON DELETE CASCADE;