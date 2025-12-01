import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

import { JOB_STATUSES, type JobStatus, STEP_STATUS_ACTIVE, STEP_STATUSES, type StepStatus } from '../../constants.js'
import type { SerializableError } from '../../errors.js'

export default function createSchema(schemaName: string) {
  const schema = pgSchema(schemaName)

  const jobsTable = schema.table(
    'jobs',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      action_name: text('action_name').notNull(),
      group_key: text('group_key').notNull(),
      status: text('status').$type<JobStatus>().notNull().default('created'),
      checksum: text('checksum').notNull(),
      input: jsonb('input').notNull().default({}),
      output: jsonb('output'),
      error: jsonb('error').$type<SerializableError>(),
      timeout_ms: integer('timeout_ms').notNull(),
      expires_at: timestamp('expires_at', { withTimezone: true }),
      started_at: timestamp('started_at', { withTimezone: true }),
      finished_at: timestamp('finished_at', { withTimezone: true }),
      owner_id: text('owner_id'),
      concurrency_limit: integer('concurrency_limit').notNull().default(10),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
        .$onUpdateFn(
          () =>
            ({
              toISOString: () => sql`now()` as any,
            }) as any,
        ),
    },
    (table) => [
      // Single column indexes
      index('idx_jobs_action_name').on(table.action_name),
      index('idx_jobs_status').on(table.status),
      index('idx_jobs_group_key').on(table.group_key),
      index('idx_jobs_started_at').on(table.started_at),
      index('idx_jobs_finished_at').on(table.finished_at),
      index('idx_jobs_expires_at').on(table.expires_at),
      index('idx_jobs_owner_id').on(table.owner_id),
      index('idx_jobs_checksum').on(table.checksum),
      index('idx_jobs_concurrency_limit').on(table.concurrency_limit),
      // Composite indexes
      index('idx_jobs_action_status').on(table.action_name, table.status),
      index('idx_jobs_action_group').on(table.action_name, table.group_key),
      // GIN indexes for full-text search
      index('idx_jobs_input_fts').using('gin', sql`to_tsvector('english', ${table.input}::text)`),
      index('idx_jobs_output_fts').using('gin', sql`to_tsvector('english', ${table.output}::text)`),
      check(
        'jobs_status_check',
        sql`${table.status} IN ${sql.raw(`(${JOB_STATUSES.map((s) => `'${s}'`).join(',')})`)}`,
      ),
    ],
  )

  const jobStepsTable = schema.table(
    'job_steps',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      job_id: uuid('job_id')
        .notNull()
        .references(() => jobsTable.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      status: text('status').$type<StepStatus>().notNull().default(STEP_STATUS_ACTIVE),
      output: jsonb('output'),
      error: jsonb('error').$type<SerializableError>(),
      started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
      finished_at: timestamp('finished_at', { withTimezone: true }),
      timeout_ms: integer('timeout_ms').notNull(),
      expires_at: timestamp('expires_at', { withTimezone: true }),
      retries_limit: integer('retries_limit').notNull().default(0),
      retries_count: integer('retries_count').notNull().default(0),
      delayed_ms: integer('delayed_ms'),
      history_failed_attempts: jsonb('history_failed_attempts')
        .$type<Record<string, { failedAt: Date; error: SerializableError; delayedMs: number }>>()
        .notNull()
        .default({}),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
        .$onUpdateFn(
          () =>
            ({
              toISOString: () => sql`now()` as any,
            }) as any,
        ),
    },
    (table) => [
      // Single column indexes
      index('idx_job_steps_job_id').on(table.job_id),
      index('idx_job_steps_status').on(table.status),
      index('idx_job_steps_name').on(table.name),
      index('idx_job_steps_expires_at').on(table.expires_at),
      // Composite indexes
      index('idx_job_steps_job_status').on(table.job_id, table.status),
      index('idx_job_steps_job_name').on(table.job_id, table.name),
      // Unique constraint
      unique('unique_job_step_name').on(table.job_id, table.name),
      check(
        'job_steps_status_check',
        sql`${table.status} IN ${sql.raw(`(${STEP_STATUSES.map((s) => `'${s}'`).join(',')})`)}`,
      ),
    ],
  )

  return {
    schema,
    jobsTable,
    jobStepsTable,
  }
}
