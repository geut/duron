CREATE SCHEMA IF NOT EXISTS "duron";
--> statement-breakpoint
CREATE TABLE "duron"."job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"job_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"timeout_ms" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"retries_limit" integer DEFAULT 0 NOT NULL,
	"retries_count" integer DEFAULT 0 NOT NULL,
	"delayed_ms" integer,
	"history_failed_attempts" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unique_job_step_name" UNIQUE("job_id","name"),
	CONSTRAINT "job_steps_status_check" CHECK ("status" IN ('active','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "duron"."jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"action_name" text NOT NULL,
	"group_key" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"checksum" text NOT NULL,
	"input" jsonb DEFAULT '{}' NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"timeout_ms" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"owner_id" text,
	"concurrency_limit" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("status" IN ('created','active','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX "idx_job_steps_job_id" ON "duron"."job_steps" ("job_id");--> statement-breakpoint
CREATE INDEX "idx_job_steps_status" ON "duron"."job_steps" ("status");--> statement-breakpoint
CREATE INDEX "idx_job_steps_name" ON "duron"."job_steps" ("name");--> statement-breakpoint
CREATE INDEX "idx_job_steps_expires_at" ON "duron"."job_steps" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_job_steps_job_status" ON "duron"."job_steps" ("job_id","status");--> statement-breakpoint
CREATE INDEX "idx_job_steps_job_name" ON "duron"."job_steps" ("job_id","name");--> statement-breakpoint
CREATE INDEX "idx_job_steps_output_fts" ON "duron"."job_steps" USING gin (to_tsvector('english', "output"::text));--> statement-breakpoint
CREATE INDEX "idx_jobs_action_name" ON "duron"."jobs" ("action_name");--> statement-breakpoint
CREATE INDEX "idx_jobs_status" ON "duron"."jobs" ("status");--> statement-breakpoint
CREATE INDEX "idx_jobs_group_key" ON "duron"."jobs" ("group_key");--> statement-breakpoint
CREATE INDEX "idx_jobs_started_at" ON "duron"."jobs" ("started_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_finished_at" ON "duron"."jobs" ("finished_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_expires_at" ON "duron"."jobs" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_owner_id" ON "duron"."jobs" ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_checksum" ON "duron"."jobs" ("checksum");--> statement-breakpoint
CREATE INDEX "idx_jobs_concurrency_limit" ON "duron"."jobs" ("concurrency_limit");--> statement-breakpoint
CREATE INDEX "idx_jobs_action_status" ON "duron"."jobs" ("action_name","status");--> statement-breakpoint
CREATE INDEX "idx_jobs_action_group" ON "duron"."jobs" ("action_name","group_key");--> statement-breakpoint
CREATE INDEX "idx_jobs_input_fts" ON "duron"."jobs" USING gin (to_tsvector('english', "input"::text));--> statement-breakpoint
CREATE INDEX "idx_jobs_output_fts" ON "duron"."jobs" USING gin (to_tsvector('english', "output"::text));--> statement-breakpoint
ALTER TABLE "duron"."job_steps" ADD CONSTRAINT "job_steps_job_id_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "duron"."jobs"("id") ON DELETE CASCADE;