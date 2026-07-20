import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import {
  JOB_STATUSES,
  type JobStatus,
  STEP_STATUS_ACTIVE,
  STEP_STATUSES,
  type StepStatus,
} from '../../constants.js'
import type { SerializableError } from '../../errors.js'

export default function createSchema(schemaName: string) {
  const schema = pgSchema(schemaName)

  // ============================================================================
  // Active Tables (Hot Path)
  // ============================================================================

  const jobsActiveTable = schema.table(
    'jobs_active',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      action_name: text('action_name').notNull(),
      group_key: text('group_key').notNull(),
      description: text('description'),
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
      concurrency_limit: integer('concurrency_limit').notNull(),
      concurrency_step_limit: integer('concurrency_step_limit').notNull(),
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
      // Single column indexes (hot path)
      index('idx_jobs_active_action_name').on(table.action_name),
      index('idx_jobs_active_status').on(table.status),
      index('idx_jobs_active_group_key').on(table.group_key),
      index('idx_jobs_active_expires_at').on(table.expires_at),
      index('idx_jobs_active_client_id').on(table.client_id),
      index('idx_jobs_active_checksum').on(table.checksum),
      // Composite indexes
      index('idx_jobs_active_action_group').on(table.action_name, table.group_key),
      check(
        'jobs_active_status_check',
        sql`${table.status} IN ${sql.raw(`(${JOB_STATUSES.map((s) => `'${s}'`).join(',')})`)}`,
      ),
    ],
  )

  const jobStepsActiveTable = schema.table(
    'job_steps_active',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      job_id: uuid('job_id')
        .notNull()
        .references(() => jobsActiveTable.id, { onDelete: 'cascade' }),
      parent_step_id: uuid('parent_step_id'),
      parallel: boolean('branch').notNull().default(false),
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
      // Single column indexes (hot path)
      index('idx_job_steps_active_job_id').on(table.job_id),
      index('idx_job_steps_active_status').on(table.status),
      index('idx_job_steps_active_name').on(table.name),
      index('idx_job_steps_active_expires_at').on(table.expires_at),
      index('idx_job_steps_active_parent_step_id').on(table.parent_step_id),
      // Unique constraint
      unique('unique_job_step_active_name_parent')
        .on(table.job_id, table.name, table.parent_step_id)
        .nullsNotDistinct(),
      check(
        'job_steps_active_status_check',
        sql`${table.status} IN ${sql.raw(`(${STEP_STATUSES.map((s) => `'${s}'`).join(',')})`)}`,
      ),
    ],
  )

  const spansTable = schema.table(
    'spans',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      trace_id: text('trace_id').notNull(),
      span_id: text('span_id').notNull(),
      parent_span_id: text('parent_span_id'),
      job_id: uuid('job_id'),
      step_id: uuid('step_id'),
      name: text('name').notNull(),
      kind: integer('kind').notNull().default(0),
      start_time_unix_nano: bigint('start_time_unix_nano', { mode: 'bigint' }).notNull(),
      end_time_unix_nano: bigint('end_time_unix_nano', { mode: 'bigint' }),
      status_code: integer('status_code').notNull().default(0),
      status_message: text('status_message'),
      attributes: jsonb('attributes').$type<Record<string, any>>().notNull().default({}),
      events: jsonb('events')
        .$type<Array<{ name: string; timeUnixNano: string; attributes?: Record<string, any> }>>()
        .notNull()
        .default([]),
    },
    (table) => [
      // Single column indexes (hot path)
      index('idx_spans_trace_id').on(table.trace_id),
      index('idx_spans_span_id').on(table.span_id),
      index('idx_spans_job_id').on(table.job_id),
      index('idx_spans_step_id').on(table.step_id),
      index('idx_spans_name').on(table.name),
      // Composite indexes
      index('idx_spans_job_step').on(table.job_id, table.step_id),
      index('idx_spans_trace_parent').on(table.trace_id, table.parent_span_id),
      // Constraints
      check('spans_kind_check', sql`${table.kind} IN (0, 1, 2, 3, 4)`),
      check('spans_status_code_check', sql`${table.status_code} IN (0, 1, 2)`),
    ],
  )

  // ============================================================================
  // Archive Tables (Terminated Work)
  // ============================================================================

  const jobsArchiveTable = schema.table(
    'jobs_archive',
    {
      id: uuid('id').primaryKey(),
      action_name: text('action_name').notNull(),
      group_key: text('group_key').notNull(),
      description: text('description'),
      status: text('status').$type<JobStatus>().notNull(),
      checksum: text('checksum').notNull(),
      input: jsonb('input').notNull().default({}),
      output: jsonb('output'),
      error: jsonb('error').$type<SerializableError>(),
      timeout_ms: integer('timeout_ms').notNull(),
      expires_at: timestamp('expires_at', { withTimezone: true }),
      started_at: timestamp('started_at', { withTimezone: true }),
      finished_at: timestamp('finished_at', { withTimezone: true }),
      client_id: text('client_id'),
      concurrency_limit: integer('concurrency_limit').notNull(),
      concurrency_step_limit: integer('concurrency_step_limit').notNull(),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      // Lookup indexes
      index('idx_jobs_archive_group_key').on(table.group_key),
      index('idx_jobs_archive_action_name').on(table.action_name),
      index('idx_jobs_archive_finished_at').on(table.finished_at),
      // Composite indexes
      index('idx_jobs_archive_action_group').on(table.action_name, table.group_key),
      // GIN indexes for full-text search (dashboard search)
      index('idx_jobs_archive_input_fts').using(
        'gin',
        sql`to_tsvector('english', ${table.input}::text)`,
      ),
      index('idx_jobs_archive_output_fts').using(
        'gin',
        sql`to_tsvector('english', ${table.output}::text)`,
      ),
      check(
        'jobs_archive_status_check',
        sql`${table.status} IN ${sql.raw(`(${JOB_STATUSES.map((s) => `'${s}'`).join(',')})`)}`,
      ),
    ],
  )

  const jobStepsArchiveTable = schema.table(
    'job_steps_archive',
    {
      id: uuid('id').primaryKey(),
      job_id: uuid('job_id')
        .notNull()
        .references(() => jobsArchiveTable.id, { onDelete: 'cascade' }),
      parent_step_id: uuid('parent_step_id'),
      parallel: boolean('branch').notNull().default(false),
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
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
      // Denormalized for easier time-based pruning
      job_finished_at: timestamp('job_finished_at', { withTimezone: true }),
    },
    (table) => [
      // Minimal indexes
      index('idx_job_steps_archive_job_id').on(table.job_id),
      index('idx_job_steps_archive_job_finished_at').on(table.job_finished_at),
      index('idx_job_steps_archive_name').on(table.name),
      check(
        'job_steps_archive_status_check',
        sql`${table.status} IN ${sql.raw(`(${STEP_STATUSES.map((s) => `'${s}'`).join(',')})`)}`,
      ),
    ],
  )

  return {
    schema,
    jobsActiveTable,
    jobsArchiveTable,
    jobStepsActiveTable,
    jobStepsArchiveTable,
    spansTable,
  }
}
