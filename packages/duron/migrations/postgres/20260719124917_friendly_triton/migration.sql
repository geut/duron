CREATE SCHEMA "duron";
--> statement-breakpoint
CREATE TABLE "duron"."job_steps_active" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"job_id" uuid NOT NULL,
	"parent_step_id" uuid,
	"branch" boolean DEFAULT false NOT NULL,
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
	CONSTRAINT "unique_job_step_active_name_parent" UNIQUE NULLS NOT DISTINCT("job_id","name","parent_step_id"),
	CONSTRAINT "job_steps_active_status_check" CHECK ("status" IN ('active','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "duron"."job_steps_archive" (
	"id" uuid PRIMARY KEY,
	"job_id" uuid NOT NULL,
	"parent_step_id" uuid,
	"branch" boolean DEFAULT false NOT NULL,
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
	"job_finished_at" timestamp with time zone,
	CONSTRAINT "job_steps_archive_status_check" CHECK ("status" IN ('active','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "duron"."jobs_active" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"action_name" text NOT NULL,
	"group_key" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'created' NOT NULL,
	"checksum" text NOT NULL,
	"input" jsonb DEFAULT '{}' NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"timeout_ms" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"client_id" text,
	"concurrency_limit" integer NOT NULL,
	"concurrency_step_limit" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_active_status_check" CHECK ("status" IN ('created','active','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "duron"."jobs_archive" (
	"id" uuid PRIMARY KEY,
	"action_name" text NOT NULL,
	"group_key" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"checksum" text NOT NULL,
	"input" jsonb DEFAULT '{}' NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"timeout_ms" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"client_id" text,
	"concurrency_limit" integer NOT NULL,
	"concurrency_step_limit" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_archive_status_check" CHECK ("status" IN ('created','active','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "duron"."spans" (
	"id" bigserial PRIMARY KEY,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"job_id" uuid,
	"step_id" uuid,
	"name" text NOT NULL,
	"kind" integer DEFAULT 0 NOT NULL,
	"start_time_unix_nano" bigint NOT NULL,
	"end_time_unix_nano" bigint,
	"status_code" integer DEFAULT 0 NOT NULL,
	"status_message" text,
	"attributes" jsonb DEFAULT '{}' NOT NULL,
	"events" jsonb DEFAULT '[]' NOT NULL,
	CONSTRAINT "spans_kind_check" CHECK ("kind" IN (0, 1, 2, 3, 4)),
	CONSTRAINT "spans_status_code_check" CHECK ("status_code" IN (0, 1, 2))
);
--> statement-breakpoint
CREATE INDEX "idx_job_steps_active_job_id" ON "duron"."job_steps_active" ("job_id");--> statement-breakpoint
CREATE INDEX "idx_job_steps_active_status" ON "duron"."job_steps_active" ("status");--> statement-breakpoint
CREATE INDEX "idx_job_steps_active_name" ON "duron"."job_steps_active" ("name");--> statement-breakpoint
CREATE INDEX "idx_job_steps_active_expires_at" ON "duron"."job_steps_active" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_job_steps_active_parent_step_id" ON "duron"."job_steps_active" ("parent_step_id");--> statement-breakpoint
CREATE INDEX "idx_job_steps_active_job_status" ON "duron"."job_steps_active" ("job_id","status");--> statement-breakpoint
CREATE INDEX "idx_job_steps_active_job_name" ON "duron"."job_steps_active" ("job_id","name");--> statement-breakpoint
CREATE INDEX "idx_job_steps_active_output_fts" ON "duron"."job_steps_active" USING gin (to_tsvector('english', "output"::text));--> statement-breakpoint
CREATE INDEX "idx_job_steps_archive_job_id" ON "duron"."job_steps_archive" ("job_id");--> statement-breakpoint
CREATE INDEX "idx_job_steps_archive_job_finished_at" ON "duron"."job_steps_archive" ("job_finished_at");--> statement-breakpoint
CREATE INDEX "idx_job_steps_archive_name" ON "duron"."job_steps_archive" ("name");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_action_name" ON "duron"."jobs_active" ("action_name");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_status" ON "duron"."jobs_active" ("status");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_group_key" ON "duron"."jobs_active" ("group_key");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_description" ON "duron"."jobs_active" ("description");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_started_at" ON "duron"."jobs_active" ("started_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_expires_at" ON "duron"."jobs_active" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_client_id" ON "duron"."jobs_active" ("client_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_checksum" ON "duron"."jobs_active" ("checksum");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_concurrency_limit" ON "duron"."jobs_active" ("concurrency_limit");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_concurrency_step_limit" ON "duron"."jobs_active" ("concurrency_step_limit");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_action_status" ON "duron"."jobs_active" ("action_name","status");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_action_group" ON "duron"."jobs_active" ("action_name","group_key");--> statement-breakpoint
CREATE INDEX "idx_jobs_active_input_fts" ON "duron"."jobs_active" USING gin (to_tsvector('english', "input"::text));--> statement-breakpoint
CREATE INDEX "idx_jobs_active_output_fts" ON "duron"."jobs_active" USING gin (to_tsvector('english', "output"::text));--> statement-breakpoint
CREATE INDEX "idx_jobs_archive_group_key" ON "duron"."jobs_archive" ("group_key");--> statement-breakpoint
CREATE INDEX "idx_jobs_archive_action_name" ON "duron"."jobs_archive" ("action_name");--> statement-breakpoint
CREATE INDEX "idx_jobs_archive_finished_at" ON "duron"."jobs_archive" ("finished_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_archive_action_group" ON "duron"."jobs_archive" ("action_name","group_key");--> statement-breakpoint
CREATE INDEX "idx_jobs_archive_input_fts" ON "duron"."jobs_archive" USING gin (to_tsvector('english', "input"::text));--> statement-breakpoint
CREATE INDEX "idx_jobs_archive_output_fts" ON "duron"."jobs_archive" USING gin (to_tsvector('english', "output"::text));--> statement-breakpoint
CREATE INDEX "idx_spans_trace_id" ON "duron"."spans" ("trace_id");--> statement-breakpoint
CREATE INDEX "idx_spans_span_id" ON "duron"."spans" ("span_id");--> statement-breakpoint
CREATE INDEX "idx_spans_job_id" ON "duron"."spans" ("job_id");--> statement-breakpoint
CREATE INDEX "idx_spans_step_id" ON "duron"."spans" ("step_id");--> statement-breakpoint
CREATE INDEX "idx_spans_name" ON "duron"."spans" ("name");--> statement-breakpoint
CREATE INDEX "idx_spans_kind" ON "duron"."spans" ("kind");--> statement-breakpoint
CREATE INDEX "idx_spans_status_code" ON "duron"."spans" ("status_code");--> statement-breakpoint
CREATE INDEX "idx_spans_job_step" ON "duron"."spans" ("job_id","step_id");--> statement-breakpoint
CREATE INDEX "idx_spans_trace_parent" ON "duron"."spans" ("trace_id","parent_span_id");--> statement-breakpoint
CREATE INDEX "idx_spans_attributes" ON "duron"."spans" USING gin ("attributes");--> statement-breakpoint
CREATE INDEX "idx_spans_events" ON "duron"."spans" USING gin ("events");--> statement-breakpoint
ALTER TABLE "duron"."job_steps_active" ADD CONSTRAINT "job_steps_active_job_id_jobs_active_id_fkey" FOREIGN KEY ("job_id") REFERENCES "duron"."jobs_active"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "duron"."job_steps_archive" ADD CONSTRAINT "job_steps_archive_job_id_jobs_archive_id_fkey" FOREIGN KEY ("job_id") REFERENCES "duron"."jobs_archive"("id") ON DELETE CASCADE;