ALTER TABLE "duron"."job_steps" ADD COLUMN "parent_step_id" uuid;--> statement-breakpoint
ALTER TABLE "duron"."job_steps" ADD COLUMN "branch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_job_steps_parent_step_id" ON "duron"."job_steps" ("parent_step_id");