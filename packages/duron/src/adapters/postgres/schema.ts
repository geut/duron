import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

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
      client_id: text('client_id'),
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
      index('idx_jobs_client_id').on(table.client_id),
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
      parent_step_id: uuid('parent_step_id'),
      parallel: boolean('branch').notNull().default(false), // DB column is 'branch', TypeScript uses 'parallel'
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
      index('idx_job_steps_parent_step_id').on(table.parent_step_id),
      // Composite indexes
      index('idx_job_steps_job_status').on(table.job_id, table.status),
      index('idx_job_steps_job_name').on(table.job_id, table.name),
      index('idx_job_steps_output_fts').using('gin', sql`to_tsvector('english', ${table.output}::text)`),
      // Unique constraint - step name is unique within a parent (name + parentStepId)
      // nullsNotDistinct ensures NULL parent_step_id values are treated as equal for uniqueness
      unique('unique_job_step_name_parent')
        .on(table.job_id, table.name, table.parent_step_id)
        .nullsNotDistinct(),
      check(
        'job_steps_status_check',
        sql`${table.status} IN ${sql.raw(`(${STEP_STATUSES.map((s) => `'${s}'`).join(',')})`)}`,
      ),
    ],
  )

  const metricsTable = schema.table(
    'metrics',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      job_id: uuid('job_id')
        .notNull()
        .references(() => jobsTable.id, { onDelete: 'cascade' }),
      step_id: uuid('step_id').references(() => jobStepsTable.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      value: doublePrecision('value').notNull(),
      attributes: jsonb('attributes').$type<Record<string, any>>().notNull().default({}),
      type: text('type').$type<'metric' | 'span_event' | 'span_attribute'>().notNull(),
      timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      // Single column indexes
      index('idx_metrics_job_id').on(table.job_id),
      index('idx_metrics_step_id').on(table.step_id),
      index('idx_metrics_name').on(table.name),
      index('idx_metrics_type').on(table.type),
      index('idx_metrics_timestamp').on(table.timestamp),
      // Composite indexes
      index('idx_metrics_job_step').on(table.job_id, table.step_id),
      index('idx_metrics_job_name').on(table.job_id, table.name),
      index('idx_metrics_job_type').on(table.job_id, table.type),
      // GIN index for JSONB attributes filtering
      index('idx_metrics_attributes').using('gin', table.attributes),
      check('metrics_type_check', sql`${table.type} IN ('metric', 'span_event', 'span_attribute')`),
    ],
  )

  return {
    schema,
    jobsTable,
    jobStepsTable,
    metricsTable,
  }
}
