import { and, between, desc, eq, gt, gte, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { PgAsyncDatabase, PgColumn } from 'drizzle-orm/pg-core'
import type { AnyRelations } from 'drizzle-orm/relations'

import {
  JOB_STATUS_ACTIVE,
  JOB_STATUS_CANCELLED,
  JOB_STATUS_COMPLETED,
  JOB_STATUS_CREATED,
  JOB_STATUS_FAILED,
  STEP_STATUS_ACTIVE,
  STEP_STATUS_CANCELLED,
  STEP_STATUS_COMPLETED,
  STEP_STATUS_FAILED,
} from '../../constants.js'
import {
  Adapter,
  type ArchiveStats,
  type CancelJobOptions,
  type CancelJobStepOptions,
  type CompleteJobOptions,
  type CompleteJobStepOptions,
  type CreateJobOptions,
  type CreateOrRecoverJobStepOptions,
  type CreateOrRecoverJobStepResult,
  type DelayJobStepOptions,
  type DeleteJobOptions,
  type DeleteJobsOptions,
  type FailJobOptions,
  type FailJobStepOptions,
  type FetchOptions,
  type GetActionsResult,
  type GetJobStepsOptions,
  type GetJobStepsResult,
  type GetJobsOptions,
  type GetJobsResult,
  type Job,
  type JobStatusResult,
  type JobStep,
  type JobStepStatusResult,
  type PruneArchiveOptions,
  type RecoverJobsOptions,
  type RetryJobOptions,
  type TimeTravelJobOptions,
} from '../adapter.js'

import createSchema from './schema.js'

export type Schema = ReturnType<typeof createSchema>

// Only the table entries from Schema (exclude the `schema` PgSchema object)
export type DrizzleSchema = Omit<Schema, 'schema'>

// Re-export types for backward compatibility
export type { Job, JobStep } from '../adapter.js'

type DrizzleDatabase = PgAsyncDatabase<any, AnyRelations>

export interface PruneSchedulerConfig {
  olderThan: string | Date | number
  intervalMs: number
  batchSize?: number
  maxBatches?: number
}

export interface AdapterOptions<Connection> {
  connection: Connection
  schema?: string
  migrateOnStart?: boolean
  migrationsFolder?: string
  pruneArchive?: PruneSchedulerConfig
}

export abstract class PostgresBaseAdapter<
  Database extends DrizzleDatabase,
  Connection,
> extends Adapter {
  protected connection: Connection
  protected db!: Database
  protected tables: Schema
  protected schema: string = 'duron'
  protected migrateOnStart: boolean = true

  // Scheduler state
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private pruneConfig: PruneSchedulerConfig | null = null
  private lastPrunedAt: Date | null = null

  // ============================================================================
  // Constructor
  // ============================================================================

  /**
   * Create a new PostgresAdapter instance.
   *
   * @param options - Configuration options for the PostgreSQL adapter
   */
  constructor(options: AdapterOptions<Connection>) {
    super()

    this.connection = options.connection
    this.schema = options.schema ?? 'duron'
    this.migrateOnStart = options.migrateOnStart ?? true
    this.pruneConfig = options.pruneArchive ?? null

    this.tables = createSchema(this.schema)

    this._initDb()
  }

  /**
   * Initialize the database connection and Drizzle instance.
   */
  protected abstract _initDb(): void

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Start the adapter.
   * Runs migrations if enabled and sets up database listeners.
   *
   * @returns Promise resolving to `true` if started successfully, `false` otherwise
   */
  protected async _start() {
    // Prune ancient client liveness rows (garbage collection for instances
    // that died long ago without a graceful release). The threshold is
    // deliberately generous — recovery uses its own much smaller threshold,
    // so this can never mark a live-but-slow instance as dead.
    try {
      await this.db.execute(sql`
        DELETE FROM ${this.tables.clientsTable}
        WHERE last_seen_at < now() - interval '24 hours'
      `)
    } catch {
      // Table may not exist yet (before migration) — skip pruning
    }

    await this._listen(`job-status-changed`, (payload: string) => {
      if (this.listenerCount('job-status-changed') > 0) {
        const { jobId, status, clientId } = JSON.parse(payload)
        this.emit('job-status-changed', { jobId, status, clientId })
      }
    })

    await this._listen(`job-available`, (payload: string) => {
      if (this.listenerCount('job-available') > 0) {
        const { jobId } = JSON.parse(payload)
        this.emit('job-available', { jobId })
      }
    })

    // Start archive prune scheduler if configured
    this._startScheduler()
  }

  protected async _stop() {
    this._stopScheduler()

    // Release liveness record so other instances can recover this
    // instance's jobs immediately instead of waiting for staleness.
    try {
      await this.db
        .delete(this.tables.clientsTable)
        .where(eq(this.tables.clientsTable.client_id, this.id))
    } catch {
      // Table may not exist yet (before migration) — skip release
    }
  }

  /**
   * Renew this instance's liveness record (upsert).
   */
  protected async _heartbeat(): Promise<void> {
    try {
      await this.db
        .insert(this.tables.clientsTable)
        .values({ client_id: this.id, last_seen_at: new Date() })
        .onConflictDoUpdate({
          target: this.tables.clientsTable.client_id,
          set: { last_seen_at: new Date() },
        })
    } catch {
      // Table may not exist yet (before migration) — skip heartbeat
    }
  }

  // ============================================================================
  // Scheduler Methods
  // ============================================================================

  /**
   * Generate a consistent advisory lock key from the schema name.
   */
  /**
   * Returns a fixed advisory lock key for the prune scheduler.
   * Uses a fixed key (42) since Duron is a single-schema system.
   * Multiple schemas would each get their own lock via the schema-prefixed table names.
   */
  private _advisoryLockKey(): number {
    return 42
  }

  /**
   * Start the archive prune scheduler.
   */
  private _startScheduler(): void {
    const config = this.pruneConfig
    if (!config) return

    const run = async () => {
      try {
        // Try to acquire advisory lock
        const lockResult = await this.db.execute<{ pg_try_advisory_lock: boolean }>(
          sql`SELECT pg_try_advisory_lock(${this._advisoryLockKey()})`,
        )

        if (!lockResult[0]?.pg_try_advisory_lock) {
          this.logger?.debug('Another process holds the prune lock, skipping')
          return
        }

        try {
          this.logger?.info('Running scheduled archive prune')
          const deleted = await this._pruneArchive({
            olderThan: config.olderThan,
            batchSize: config.batchSize,
            maxBatches: config.maxBatches,
          })
          this.lastPrunedAt = new Date()
          this.logger?.info({ deletedJobs: deleted }, 'Archive prune completed')
        } finally {
          await this.db.execute(sql`SELECT pg_advisory_unlock(${this._advisoryLockKey()})`)
        }
      } catch (error) {
        this.logger?.error(error, 'Error in prune scheduler')
      }
    }

    // Run immediately on start, then on interval
    run().catch((err) => this.logger?.error(err, 'Initial prune run failed'))
    this.pruneTimer = setInterval(run, config.intervalMs)
  }

  /**
   * Stop the archive prune scheduler.
   */
  private _stopScheduler(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
  }

  // ============================================================================
  // Job Methods
  // ============================================================================

  /**
   * Internal method to create a new job in the database.
   *
   * @returns Promise resolving to the job ID, or `null` if creation failed
   */
  protected async _createJob({
    queue,
    groupKey,
    input,
    timeoutMs,
    checksum,
    concurrencyLimit,
    concurrencyStepLimit,
    description,
  }: CreateJobOptions) {
    const [result] = await this.db
      .insert(this.tables.jobsActiveTable)
      .values({
        action_name: queue,
        group_key: groupKey,
        description: description ?? null,
        checksum,
        input,
        status: JOB_STATUS_CREATED,
        timeout_ms: timeoutMs,
        concurrency_limit: concurrencyLimit,
        concurrency_step_limit: concurrencyStepLimit,
      })
      .returning({ id: this.tables.jobsActiveTable.id })

    if (!result) {
      return null
    }

    return result.id
  }

  /**
   * Internal method to mark a job as completed.
   *
   * @returns Promise resolving to `true` if completed, `false` otherwise
   */
  protected async _completeJob({ jobId, output }: CompleteJobOptions) {
    return this.db.transaction(async (tx) => {
      const finishedAt = new Date()

      // 1. Check job exists and meets conditions before archiving
      const [job] = await tx
        .select()
        .from(this.tables.jobsActiveTable)
        .where(
          and(
            eq(this.tables.jobsActiveTable.id, jobId),
            eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE),
            eq(this.tables.jobsActiveTable.client_id, this.id),
            gt(this.tables.jobsActiveTable.expires_at, sql`now()`),
          ),
        )

      if (!job) {
        return false
      }

      // 2. Insert job into archive FIRST (required for FK constraints)
      await tx.insert(this.tables.jobsArchiveTable).values({
        ...job,
        status: JOB_STATUS_COMPLETED,
        output,
        finished_at: finishedAt,
        updated_at: finishedAt,
      })

      // 3. Archive steps using INSERT ... SELECT (SQL-native, no JS round-trip)
      await tx.execute(sql`
        INSERT INTO ${this.tables.jobStepsArchiveTable} (
          id, job_id, parent_step_id, parallel, name, status, output, error,
          started_at, finished_at, timeout_ms, expires_at, retries_limit,
          retries_count, delayed_ms, history_failed_attempts, created_at,
          updated_at, job_finished_at
        )
        SELECT
          id, job_id, parent_step_id, parallel, name, status, output, error,
          started_at, finished_at, timeout_ms, expires_at, retries_limit,
          retries_count, delayed_ms, history_failed_attempts, created_at,
          updated_at, ${finishedAt.toISOString()}
        FROM ${this.tables.jobStepsActiveTable}
        WHERE job_id = ${jobId}
      `)

      // 4. Delete job from active (cascade deletes steps)
      await tx.delete(this.tables.jobsActiveTable).where(eq(this.tables.jobsActiveTable.id, jobId))

      return true
    })
  }

  /**
   * Internal method to mark a job as failed.
   *
   * @returns Promise resolving to `true` if failed, `false` otherwise
   */
  protected async _failJob({ jobId, error }: FailJobOptions) {
    return this.db.transaction(async (tx) => {
      const finishedAt = new Date()

      // 1. Check job exists before archiving
      const [job] = await tx
        .select()
        .from(this.tables.jobsActiveTable)
        .where(
          and(
            eq(this.tables.jobsActiveTable.id, jobId),
            eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE),
            eq(this.tables.jobsActiveTable.client_id, this.id),
          ),
        )

      if (!job) {
        return false
      }

      // 2. Insert job into archive FIRST (required for FK constraints)
      await tx.insert(this.tables.jobsArchiveTable).values({
        ...job,
        status: JOB_STATUS_FAILED,
        error,
        finished_at: finishedAt,
        updated_at: finishedAt,
      })

      // 3. Archive steps using INSERT ... SELECT
      await tx.execute(sql`
        INSERT INTO ${this.tables.jobStepsArchiveTable} (
          id, job_id, parent_step_id, parallel, name, status, output, error,
          started_at, finished_at, timeout_ms, expires_at, retries_limit,
          retries_count, delayed_ms, history_failed_attempts, created_at,
          updated_at, job_finished_at
        )
        SELECT
          id, job_id, parent_step_id, parallel, name, status, output, error,
          started_at, finished_at, timeout_ms, expires_at, retries_limit,
          retries_count, delayed_ms, history_failed_attempts, created_at,
          updated_at, ${finishedAt.toISOString()}
        FROM ${this.tables.jobStepsActiveTable}
        WHERE job_id = ${jobId}
      `)

      // 4. Delete job from active (cascade deletes steps)
      await tx.delete(this.tables.jobsActiveTable).where(eq(this.tables.jobsActiveTable.id, jobId))

      return true
    })
  }

  /**
   * Internal method to cancel a job.
   *
   * @returns Promise resolving to `true` if cancelled, `false` otherwise
   */
  protected async _cancelJob({ jobId }: CancelJobOptions) {
    return this.db.transaction(async (tx) => {
      const finishedAt = new Date()

      // 1. Check job exists before updating steps
      const [job] = await tx
        .select()
        .from(this.tables.jobsActiveTable)
        .where(
          and(
            eq(this.tables.jobsActiveTable.id, jobId),
            or(
              eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE),
              eq(this.tables.jobsActiveTable.status, JOB_STATUS_CREATED),
            ),
          ),
        )

      if (!job) {
        return false
      }

      // 2. Update all steps to cancelled status
      await tx
        .update(this.tables.jobStepsActiveTable)
        .set({
          status: STEP_STATUS_CANCELLED,
          finished_at: finishedAt,
          updated_at: finishedAt,
        })
        .where(eq(this.tables.jobStepsActiveTable.job_id, jobId))

      // 3. Insert job into archive FIRST (required for FK constraints)
      await tx.insert(this.tables.jobsArchiveTable).values({
        ...job,
        status: JOB_STATUS_CANCELLED,
        finished_at: finishedAt,
        updated_at: finishedAt,
      })

      // 4. Archive steps using INSERT ... SELECT
      await tx.execute(sql`
        INSERT INTO ${this.tables.jobStepsArchiveTable} (
          id, job_id, parent_step_id, parallel, name, status, output, error,
          started_at, finished_at, timeout_ms, expires_at, retries_limit,
          retries_count, delayed_ms, history_failed_attempts, created_at,
          updated_at, job_finished_at
        )
        SELECT
          id, job_id, parent_step_id, parallel, name, status, output, error,
          started_at, finished_at, timeout_ms, expires_at, retries_limit,
          retries_count, delayed_ms, history_failed_attempts, created_at,
          updated_at, ${finishedAt.toISOString()}
        FROM ${this.tables.jobStepsActiveTable}
        WHERE job_id = ${jobId}
      `)

      // 5. Delete job from active (cascade deletes steps)
      await tx.delete(this.tables.jobsActiveTable).where(eq(this.tables.jobsActiveTable.id, jobId))

      return true
    })
  }

  /**
   * Internal method to retry a completed, cancelled, or failed job by creating a copy of it with status 'created' and cleared output/error.
   * Uses SELECT FOR UPDATE to prevent concurrent retries from creating duplicate jobs.
   *
   * @returns Promise resolving to the job ID, or `null` if creation failed
   */
  protected async _retryJob({ jobId }: RetryJobOptions): Promise<string | null> {
    // Use a single atomic query with FOR UPDATE lock to prevent race conditions
    const result = this._map(
      await this.db.execute<{ id: string }>(sql`
      WITH locked_source AS (
        -- Lock the source job row to prevent concurrent retries
        SELECT
          j.action_name,
          j.group_key,
          j.description,
          j.checksum,
          j.input,
          j.timeout_ms,
          j.created_at,
          j.concurrency_limit,
          j.concurrency_step_limit
        FROM ${this.tables.jobsArchiveTable} j
        WHERE j.id = ${jobId}
          AND j.status IN (${JOB_STATUS_COMPLETED}, ${JOB_STATUS_CANCELLED}, ${JOB_STATUS_FAILED})
        FOR UPDATE
      ),
      existing_retry AS (
        -- Check if a retry already exists (a newer job with same checksum, group_key, and input)
        SELECT j.id
        FROM ${this.tables.jobsActiveTable} j
        INNER JOIN locked_source ls
          ON j.action_name = ls.action_name
          AND j.group_key = ls.group_key
          AND j.checksum = ls.checksum
          AND j.input = ls.input
          AND j.created_at > ls.created_at
        WHERE j.status IN (${JOB_STATUS_CREATED}, ${JOB_STATUS_ACTIVE})
        LIMIT 1
      ),
      inserted_retry AS (
        -- Insert the retry only if no existing retry was found
        -- Get concurrency_limit from the latest job at insertion time to avoid stale values
        INSERT INTO ${this.tables.jobsActiveTable} (
          action_name,
          group_key,
          description,
          checksum,
          input,
          status,
          timeout_ms,
          concurrency_limit,
          concurrency_step_limit
        )
        SELECT
          ls.action_name,
          ls.group_key,
          ls.description,
          ls.checksum,
          ls.input,
          ${JOB_STATUS_CREATED},
          ls.timeout_ms,
          COALESCE(
            (
              SELECT j.concurrency_limit
              FROM ${this.tables.jobsActiveTable} j
              WHERE j.action_name = ls.action_name
                AND j.group_key = ls.group_key
                AND (j.expires_at IS NULL OR j.expires_at > now())
              ORDER BY j.created_at DESC, j.id DESC
              LIMIT 1
            ),
            ls.concurrency_limit
          ),
          ls.concurrency_step_limit
        FROM locked_source ls
        WHERE NOT EXISTS (SELECT 1 FROM existing_retry)
        RETURNING id
      )
      -- Return only the newly inserted retry ID (not existing retries)
      SELECT id FROM inserted_retry
      LIMIT 1
    `),
    )

    if (result.length === 0) {
      return null
    }

    return result[0]!.id
  }

  /**
   * Internal method to time travel a job to restart from a specific step.
   * The job must be in completed, failed, or cancelled status.
   * Resets the job and ancestor steps to active status, deletes subsequent steps,
   * and preserves completed parallel siblings.
   *
   * Algorithm:
   * 1. Validate job is in terminal state (completed/failed/cancelled)
   * 2. Find the target step and all its ancestors (using parent_step_id)
   * 3. Determine which steps to keep:
   *    - Steps completed BEFORE the target step (by created_at)
   *    - Branch siblings that are completed (independent)
   * 4. Delete steps that should not be kept
   * 5. Reset ancestor steps to active status (they need to re-run)
   * 6. Reset the target step to active status
   * 7. Reset job to created status
   *
   * @returns Promise resolving to `true` if time travel succeeded, `false` otherwise
   */
  protected async _timeTravelJob({ jobId, stepId }: TimeTravelJobOptions): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // First, check if the job is in the archive and restore it if needed
      const archivedJob = await tx
        .select()
        .from(this.tables.jobsArchiveTable)
        .where(eq(this.tables.jobsArchiveTable.id, jobId))
        .limit(1)

      if (archivedJob.length > 0) {
        // Restore job from archive to active
        // Use ON CONFLICT DO NOTHING to handle concurrent time-travel gracefully
        const job = archivedJob[0]!
        await tx
          .insert(this.tables.jobsActiveTable)
          .values({ ...job })
          .onConflictDoNothing()

        // Restore steps from archive to active
        const archivedSteps = await tx
          .select()
          .from(this.tables.jobStepsArchiveTable)
          .where(eq(this.tables.jobStepsArchiveTable.job_id, jobId))

        if (archivedSteps.length > 0) {
          await tx
            .insert(this.tables.jobStepsActiveTable)
            .values(archivedSteps.map((s) => ({ ...s })))
            .onConflictDoNothing()
        }

        // Delete archived job and steps (cascade via FK on steps)
        await tx
          .delete(this.tables.jobsArchiveTable)
          .where(eq(this.tables.jobsArchiveTable.id, jobId))
      }

      const result = this._map(
        await tx.execute<{ success: boolean }>(sql`
        WITH RECURSIVE
        -- Lock and validate the job
        locked_job AS (
          SELECT j.id
          FROM ${this.tables.jobsActiveTable} j
          WHERE j.id = ${jobId}
            AND j.status IN (${JOB_STATUS_COMPLETED}, ${JOB_STATUS_FAILED}, ${JOB_STATUS_CANCELLED})
          FOR UPDATE OF j
        ),
        -- Validate target step exists and belongs to job
        target_step AS (
          SELECT s.id, s.parent_step_id, s.created_at
          FROM ${this.tables.jobStepsActiveTable} s
          WHERE s.id = ${stepId}
            AND s.job_id = ${jobId}
            AND EXISTS (SELECT 1 FROM locked_job)
        ),
      -- Find all ancestor steps recursively (from target up to root)
      ancestors AS (
        SELECT s.id, s.parent_step_id, 0 AS depth
        FROM ${this.tables.jobStepsActiveTable} s
        WHERE s.id = (SELECT parent_step_id FROM target_step)
          AND EXISTS (SELECT 1 FROM target_step)
        UNION ALL
        SELECT s.id, s.parent_step_id, a.depth + 1
        FROM ${this.tables.jobStepsActiveTable} s
        INNER JOIN ancestors a ON s.id = a.parent_step_id
      ),
      -- Steps to keep: completed steps created before target + completed parallel siblings of target and ancestors + their descendants
      parallel_siblings AS (
        -- Completed parallel siblings of target step
        SELECT s.id
        FROM ${this.tables.jobStepsActiveTable} s
        CROSS JOIN target_step ts
        WHERE s.job_id = ${jobId}
          AND s.id != ts.id
          AND s.parallel = true
          AND s.status = ${STEP_STATUS_COMPLETED}
          AND (
            (s.parent_step_id IS NULL AND ts.parent_step_id IS NULL)
            OR s.parent_step_id = ts.parent_step_id
          )
        UNION
        -- Completed parallel siblings of each ancestor
        SELECT s.id
        FROM ${this.tables.jobStepsActiveTable} s
        INNER JOIN ancestors a ON (
          (s.parent_step_id IS NULL AND a.parent_step_id IS NULL)
          OR s.parent_step_id = a.parent_step_id
        )
        WHERE s.job_id = ${jobId}
          AND s.id NOT IN (SELECT id FROM ancestors)
          AND s.parallel = true
          AND s.status = ${STEP_STATUS_COMPLETED}
      ),
      -- Find all descendants of parallel siblings (to keep their children too)
      parallel_descendants AS (
        SELECT s.id
        FROM ${this.tables.jobStepsActiveTable} s
        WHERE s.id IN (SELECT id FROM parallel_siblings)
        UNION ALL
        SELECT s.id
        FROM ${this.tables.jobStepsActiveTable} s
        INNER JOIN parallel_descendants pd ON s.parent_step_id = pd.id
        WHERE s.job_id = ${jobId}
      ),
      steps_to_keep AS (
        -- Steps created before target that are completed (non-ancestor, non-target)
        SELECT s.id
        FROM ${this.tables.jobStepsActiveTable} s
        CROSS JOIN target_step ts
        WHERE s.job_id = ${jobId}
          AND s.created_at < ts.created_at
          AND s.status = ${STEP_STATUS_COMPLETED}
          AND s.id NOT IN (SELECT id FROM ancestors)
          AND s.id != ts.id
        UNION
        -- All parallel siblings and their descendants
        SELECT id FROM parallel_descendants
      ),
      -- Calculate time offset: shift preserved steps to start from "now"
      time_offset AS (
        SELECT
          now() - MIN(s.started_at) AS offset_interval
        FROM ${this.tables.jobStepsActiveTable} s
        WHERE s.id IN (SELECT id FROM steps_to_keep)
      ),
      -- Shift times of preserved steps to align with current time (only started_at/finished_at, NOT created_at to preserve ordering)
      shift_preserved_times AS (
        UPDATE ${this.tables.jobStepsActiveTable}
        SET
          started_at = started_at + (SELECT offset_interval FROM time_offset),
          finished_at = CASE
            WHEN finished_at IS NOT NULL
            THEN finished_at + (SELECT offset_interval FROM time_offset)
            ELSE NULL
          END,
          updated_at = now()
        WHERE id IN (SELECT id FROM steps_to_keep)
          AND (SELECT offset_interval FROM time_offset) IS NOT NULL
        RETURNING id
      ),
      -- Delete steps that are not in the keep list and are not ancestors/target
      deleted_steps AS (
        DELETE FROM ${this.tables.jobStepsActiveTable}
        WHERE job_id = ${jobId}
          AND id NOT IN (SELECT id FROM steps_to_keep)
          AND id NOT IN (SELECT id FROM ancestors)
          AND id != (SELECT id FROM target_step)
        RETURNING id
      ),
      -- Reset ancestor steps to active
      reset_ancestors AS (
        UPDATE ${this.tables.jobStepsActiveTable}
        SET
          status = ${STEP_STATUS_ACTIVE},
          output = NULL,
          error = NULL,
          finished_at = NULL,
          started_at = now(),
          expires_at = now() + (timeout_ms || ' milliseconds')::interval,
          retries_count = 0,
          delayed_ms = NULL,
          history_failed_attempts = '{}'::jsonb,
          updated_at = now()
        WHERE id IN (SELECT id FROM ancestors)
        RETURNING id
      ),
      -- Reset target step to active
      reset_target AS (
        UPDATE ${this.tables.jobStepsActiveTable}
        SET
          status = ${STEP_STATUS_ACTIVE},
          output = NULL,
          error = NULL,
          finished_at = NULL,
          started_at = now(),
          expires_at = now() + (timeout_ms || ' milliseconds')::interval,
          retries_count = 0,
          delayed_ms = NULL,
          history_failed_attempts = '{}'::jsonb,
          updated_at = now()
        WHERE id = (SELECT id FROM target_step)
        RETURNING id
      ),
      -- Reset job to created status
      reset_job AS (
        UPDATE ${this.tables.jobsActiveTable}
        SET
          status = ${JOB_STATUS_CREATED},
          output = NULL,
          error = NULL,
          started_at = NULL,
          finished_at = NULL,
          client_id = NULL,
          expires_at = NULL,
          updated_at = now()
        WHERE id = ${jobId}
          AND EXISTS (SELECT 1 FROM target_step)
        RETURNING id
      )
      SELECT EXISTS(SELECT 1 FROM reset_job) AS success
    `),
      )

      return result.length > 0 && result[0]!.success === true
    })
  }

  /**
   * Internal method to delete a job by its ID.
   * Active jobs cannot be deleted.
   *
   * @returns Promise resolving to `true` if deleted, `false` otherwise
   */
  protected async _deleteJob({ jobId }: DeleteJobOptions): Promise<boolean> {
    const result = await this.db
      .delete(this.tables.jobsActiveTable)
      .where(
        and(
          eq(this.tables.jobsActiveTable.id, jobId),
          ne(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE),
        ),
      )
      .returning({ id: this.tables.jobsActiveTable.id })

    // Also delete associated steps
    if (result.length > 0) {
      await this.db
        .delete(this.tables.jobStepsActiveTable)
        .where(eq(this.tables.jobStepsActiveTable.job_id, jobId))
    }

    return result.length > 0
  }

  /**
   * Internal method to delete multiple jobs using the same filters as getJobs.
   * Active jobs cannot be deleted and will be excluded from deletion.
   *
   * @returns Promise resolving to the number of jobs deleted
   */
  /**
   * Internal method to delete multiple jobs using the same filters as getJobs.
   * Only operates on active (non-running) jobs. Archive jobs are not affected.
   * Active jobs (status='active') are always excluded to prevent data loss.
   *
   * @returns Promise resolving to the number of jobs deleted
   */
  protected async _deleteJobs(options?: DeleteJobsOptions): Promise<number> {
    const jobsTable = this.tables.jobsActiveTable
    const filters = options?.filters ?? {}
    // Always exclude active jobs from bulk deletion to prevent data loss
    // Note: This only deletes from jobs_active, not jobs_archive
    const where = and(this._buildJobsWhereClause(filters), ne(jobsTable.status, JOB_STATUS_ACTIVE))

    const result = await this.db.delete(jobsTable).where(where).returning({ id: jobsTable.id })
    return result.length
  }

  /**
   * Internal method to fetch jobs from the database respecting concurrency limits per group.
   * Uses the concurrency limit from the latest job created for each groupKey.
   * Uses advisory locks to ensure thread-safe job fetching.
   *
   * @returns Promise resolving to an array of fetched jobs
   */
  protected async _fetch({ batch }: FetchOptions) {
    const result = this._map(
      await this.db.execute<Job>(sql`
      WITH group_concurrency AS (
        -- Get the concurrency limit from the latest job for each group
        SELECT DISTINCT ON (j.group_key, j.action_name)
          j.group_key as group_key,
          j.action_name as action_name,
          j.concurrency_limit as concurrency_limit
        FROM ${this.tables.jobsActiveTable} j
        WHERE j.group_key IS NOT NULL
          AND (j.expires_at IS NULL OR j.expires_at > now())
        ORDER BY j.group_key, j.action_name, j.created_at DESC, j.id DESC
      ),
      eligible_groups AS (
        -- Find all groups with their active counts that are below their concurrency limit
        SELECT
          gc.group_key,
          gc.action_name,
          gc.concurrency_limit,
          COUNT(*) FILTER (WHERE j.status = ${JOB_STATUS_ACTIVE}) as active_count
        FROM group_concurrency gc
        LEFT JOIN ${this.tables.jobsActiveTable} j
          ON j.group_key = gc.group_key
          AND j.action_name = gc.action_name
          AND (j.expires_at IS NULL OR j.expires_at > now())
        GROUP BY gc.group_key, gc.action_name, gc.concurrency_limit
        HAVING COUNT(*) FILTER (WHERE j.status = ${JOB_STATUS_ACTIVE}) < gc.concurrency_limit
      ),
      candidate_jobs AS (
        -- Lock candidate jobs first (before applying window functions)
        SELECT
          j.id,
          j.action_name,
          j.group_key as job_group_key,
          j.created_at
        FROM ${this.tables.jobsActiveTable} j
        INNER JOIN eligible_groups eg
          ON j.group_key = eg.group_key
          AND j.action_name = eg.action_name
        WHERE j.status = ${JOB_STATUS_CREATED}
        FOR UPDATE OF j SKIP LOCKED
      ),
      ranked_jobs AS (
        -- Rank jobs within each group after locking
        SELECT
          cj.id,
          cj.action_name,
          cj.job_group_key,
          cj.created_at,
          ROW_NUMBER() OVER (
            PARTITION BY cj.job_group_key, cj.action_name
            ORDER BY cj.created_at ASC, cj.id ASC
          ) as job_rank
        FROM candidate_jobs cj
      ),
      next_job AS (
        -- Select only jobs that fit within the concurrency limit per group
        -- Ordered globally by created_at to respect job creation order
        SELECT rj.id, rj.action_name, rj.job_group_key
        FROM ranked_jobs rj
        INNER JOIN eligible_groups eg
          ON rj.job_group_key = eg.group_key
          AND rj.action_name = eg.action_name
        WHERE rj.job_rank <= (eg.concurrency_limit - eg.active_count)
        ORDER BY rj.created_at ASC, rj.id ASC
        LIMIT ${batch}
      )
      UPDATE ${this.tables.jobsActiveTable} j
      SET status = ${JOB_STATUS_ACTIVE},
          started_at = now(),
          expires_at = now() + (timeout_ms || ' milliseconds')::interval,
          client_id = ${this.id},
          updated_at = now()
      FROM next_job nj
      INNER JOIN eligible_groups eg
        ON nj.job_group_key = eg.group_key
        AND nj.action_name = eg.action_name
      WHERE j.id = nj.id
        AND eg.active_count < eg.concurrency_limit
      RETURNING
        j.id,
        j.action_name as "actionName",
        j.group_key as "groupKey",
        j.description,
        j.input,
        j.output,
        j.error,
        j.status,
        j.timeout_ms as "timeoutMs",
        j.expires_at as "expiresAt",
        j.started_at as "startedAt",
        j.finished_at as "finishedAt",
        j.created_at as "createdAt",
        j.updated_at as "updatedAt",
        j.concurrency_limit as "concurrencyLimit",
        j.concurrency_step_limit as "concurrencyStepLimit"
    `),
    )

    return result
  }

  /**
   * Internal method to recover stuck jobs (jobs that were active but the process that owned them is no longer running).
   * Uses the clients liveness table to detect dead owners: a client whose heartbeat is older than staleTimeoutMs (or missing) is considered dead.
   *
   * @returns Promise resolving to the number of jobs recovered
   */
  protected async _recoverJobs(options: RecoverJobsOptions): Promise<number> {
    const { checksums, staleTimeoutMs = 15_000 } = options

    // Find owners of active jobs that are dead: no liveness row or stale heartbeat.
    // This instance's own id is always included to recover jobs left behind
    // by a previous run of the same client.
    const deadOwners: { client_id: string }[] = this._map(
      await this.db.execute<{ client_id: string }>(sql`
        SELECT DISTINCT j.client_id
        FROM ${this.tables.jobsActiveTable} j
        WHERE j.status = ${JOB_STATUS_ACTIVE}
          AND j.client_id IS NOT NULL
          AND j.client_id != ${this.id}
          AND NOT EXISTS (
            SELECT 1 FROM ${this.tables.clientsTable} c
            WHERE c.client_id = j.client_id
              AND c.last_seen_at > now() - (${staleTimeoutMs} * interval '1 millisecond')
          )
      `),
    )

    const unresponsiveClientIds: string[] = [this.id, ...deadOwners.map((row) => row.client_id)]

    let recoveredCount = 0

    // Archive expired active jobs from unresponsive clients
    const expiredJobs = this._map(
      await this.db.execute<{ id: string }>(sql`
        WITH locked_expired_jobs AS (
          SELECT j.*
          FROM ${this.tables.jobsActiveTable} j
          WHERE j.status = ${JOB_STATUS_ACTIVE}
            AND j.expires_at IS NOT NULL
            AND j.expires_at <= now()
            AND j.client_id IN ${unresponsiveClientIds}
          FOR UPDATE OF j SKIP LOCKED
        ),
        archived_jobs AS (
          INSERT INTO ${this.tables.jobsArchiveTable} (
            id, action_name, group_key, description, checksum, input, output, error,
            status, timeout_ms, expires_at, started_at, finished_at, client_id,
            concurrency_limit, concurrency_step_limit, created_at, updated_at
          )
          SELECT
            id, action_name, group_key, description, checksum, input, output,
            jsonb_build_object('message', 'Job expired after exceeding timeout'),
            ${JOB_STATUS_FAILED},
            timeout_ms, expires_at, started_at, now(), client_id,
            concurrency_limit, concurrency_step_limit, created_at, now()
          FROM locked_expired_jobs
          RETURNING id, checksum
        ),
        archived_steps AS (
          INSERT INTO ${this.tables.jobStepsArchiveTable} (
            id, job_id, parent_step_id, parallel, name, status, output, error,
            started_at, finished_at, timeout_ms, expires_at, retries_limit,
            retries_count, delayed_ms, history_failed_attempts, created_at,
            updated_at, job_finished_at
          )
          SELECT
            id, job_id, parent_step_id, parallel, name, status, output, error,
            started_at, finished_at, timeout_ms, expires_at, retries_limit,
            retries_count, delayed_ms, history_failed_attempts, created_at,
            updated_at, now()
          FROM ${this.tables.jobStepsActiveTable}
          WHERE job_id IN (SELECT id FROM archived_jobs)
        ),
        deleted_jobs AS (
          DELETE FROM ${this.tables.jobsActiveTable} j
          WHERE j.id IN (SELECT id FROM archived_jobs)
          RETURNING id
        )
        SELECT id FROM deleted_jobs
      `),
    )

    recoveredCount += expiredJobs.length

    if (unresponsiveClientIds.length > 0) {
      const result = this._map(
        await this.db.execute<{ id: string }>(sql`
        WITH locked_jobs AS (
          SELECT j.id
          FROM ${this.tables.jobsActiveTable} j
          WHERE j.status = ${JOB_STATUS_ACTIVE}
            AND j.client_id IN ${unresponsiveClientIds}
            AND (j.expires_at IS NULL OR j.expires_at > now())
          FOR UPDATE OF j SKIP LOCKED
        ),
        updated_jobs AS (
          UPDATE ${this.tables.jobsActiveTable} j
          SET status = ${JOB_STATUS_CREATED},
              started_at = NULL,
              expires_at = NULL,
              finished_at = NULL,
              output = NULL,
              error = NULL,
              updated_at = now()
          WHERE EXISTS (SELECT 1 FROM locked_jobs lj WHERE lj.id = j.id)
          RETURNING id, checksum
        ),
        deleted_steps AS (
          DELETE FROM ${this.tables.jobStepsActiveTable} s
          WHERE EXISTS (
            SELECT 1 FROM updated_jobs uj
            WHERE uj.id = s.job_id
            AND uj.checksum NOT IN ${checksums}
          )
        )
        SELECT id FROM updated_jobs
      `),
      )

      recoveredCount += result.length
    }

    return recoveredCount
  }

  // ============================================================================
  // Step Methods
  // ============================================================================

  /**
   * Internal method to create or recover a job step by creating or resetting a step record in the database.
   *
   * @returns Promise resolving to the step, or `null` if creation failed
   */
  protected async _createOrRecoverJobStep({
    jobId,
    name,
    timeoutMs,
    retriesLimit,
    parentStepId,
    parallel = false,
  }: CreateOrRecoverJobStepOptions): Promise<CreateOrRecoverJobStepResult | null> {
    type StepResult = CreateOrRecoverJobStepResult

    const [result] = this._map(
      await this.db.execute<StepResult>(sql`
      WITH job_check AS (
        SELECT j.id
        FROM ${this.tables.jobsActiveTable} j
        WHERE j.id = ${jobId}
          AND j.status = ${JOB_STATUS_ACTIVE}
          AND (j.expires_at IS NULL OR j.expires_at > now())
      ),
      step_existed AS (
        SELECT EXISTS(
          SELECT 1 FROM ${this.tables.jobStepsActiveTable} s
          WHERE s.job_id = ${jobId}
            AND s.name = ${name}
            AND s.parent_step_id IS NOT DISTINCT FROM ${parentStepId}
        ) AS existed
      ),
      upserted_step AS (
        INSERT INTO ${this.tables.jobStepsActiveTable} (
          job_id,
          parent_step_id,
          parallel,
          name,
          timeout_ms,
          retries_limit,
          status,
          started_at,
          expires_at,
          retries_count,
          delayed_ms
        )
        SELECT
          ${jobId},
          ${parentStepId},
          ${parallel},
          ${name},
          ${timeoutMs},
          ${retriesLimit},
          ${STEP_STATUS_ACTIVE},
          now(),
          now() + (${timeoutMs} * interval '1 millisecond'),
          0,
          NULL
        WHERE EXISTS (SELECT 1 FROM job_check)
        ON CONFLICT (job_id, name, parent_step_id) DO UPDATE
        SET
          timeout_ms = ${timeoutMs},
          expires_at = now() + (${timeoutMs} * interval '1 millisecond'),
          retries_count = 0,
          retries_limit = ${retriesLimit},
          delayed_ms = NULL,
          started_at = now(),
          history_failed_attempts = '{}'::jsonb
        WHERE ${this.tables.jobStepsActiveTable}.status = ${STEP_STATUS_ACTIVE}
        RETURNING
          id,
          status,
          retries_limit AS "retriesLimit",
          retries_count AS "retriesCount",
          timeout_ms AS "timeoutMs",
          error,
          output
      ),
      final_upserted AS (
        SELECT
          us.*,
          CASE WHEN se.existed THEN false ELSE true END AS "isNew"
        FROM upserted_step us
        CROSS JOIN step_existed se
      ),
      existing_step AS (
        SELECT
          s.id,
          s.status,
          s.retries_limit AS "retriesLimit",
          s.retries_count AS "retriesCount",
          s.timeout_ms AS "timeoutMs",
          s.error,
          s.output,
          false AS "isNew"
        FROM ${this.tables.jobStepsActiveTable} s
        INNER JOIN job_check jc ON s.job_id = jc.id
        WHERE s.job_id = ${jobId}
          AND s.name = ${name}
          AND s.parent_step_id IS NOT DISTINCT FROM ${parentStepId}
          AND NOT EXISTS (SELECT 1 FROM final_upserted)
      )
      SELECT * FROM final_upserted
      UNION ALL
      SELECT * FROM existing_step
    `),
    )

    if (!result) {
      this.logger?.error({ jobId }, `[PostgresAdapter] Job ${jobId} is not active or has expired`)
      return null
    }

    return result
  }

  /**
   * Internal method to mark a job step as completed.
   *
   * @returns Promise resolving to `true` if completed, `false` otherwise
   */
  protected async _completeJobStep({ stepId, output }: CompleteJobStepOptions) {
    const result = await this.db
      .update(this.tables.jobStepsActiveTable)
      .set({
        status: STEP_STATUS_COMPLETED,
        output,
        finished_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .from(this.tables.jobsActiveTable)
      .where(
        and(
          eq(this.tables.jobStepsActiveTable.job_id, this.tables.jobsActiveTable.id),
          eq(this.tables.jobStepsActiveTable.id, stepId),
          eq(this.tables.jobStepsActiveTable.status, STEP_STATUS_ACTIVE),
          eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE),
          or(
            isNull(this.tables.jobsActiveTable.expires_at),
            gt(this.tables.jobsActiveTable.expires_at, sql`now()`),
          ),
        ),
      )
      .returning({ id: this.tables.jobStepsActiveTable.id })

    return result.length > 0
  }

  /**
   * Internal method to mark a job step as failed.
   *
   * @returns Promise resolving to `true` if failed, `false` otherwise
   */
  protected async _failJobStep({ stepId, error }: FailJobStepOptions) {
    const result = await this.db
      .update(this.tables.jobStepsActiveTable)
      .set({
        status: STEP_STATUS_FAILED,
        error,
        finished_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .from(this.tables.jobsActiveTable)
      .where(
        and(
          eq(this.tables.jobStepsActiveTable.job_id, this.tables.jobsActiveTable.id),
          eq(this.tables.jobStepsActiveTable.id, stepId),
          eq(this.tables.jobStepsActiveTable.status, STEP_STATUS_ACTIVE),
          eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE),
        ),
      )
      .returning({ id: this.tables.jobStepsActiveTable.id })

    return result.length > 0
  }

  /**
   * Internal method to delay a job step.
   *
   * @returns Promise resolving to `true` if delayed, `false` otherwise
   */
  protected async _delayJobStep({ stepId, delayMs, error }: DelayJobStepOptions) {
    const jobStepsTable = this.tables.jobStepsActiveTable
    const jobsTable = this.tables.jobsActiveTable

    const result = await this.db
      .update(jobStepsTable)
      .set({
        delayed_ms: delayMs,
        retries_count: sql`${jobStepsTable.retries_count} + 1`,
        expires_at: sql`now() + (${jobStepsTable.timeout_ms} || ' milliseconds')::interval + (${delayMs} || ' milliseconds')::interval`,
        history_failed_attempts: sql`COALESCE(${jobStepsTable.history_failed_attempts}, '{}'::jsonb) || jsonb_build_object(
          extract(epoch from now())::text,
          jsonb_build_object(
            'failedAt', now(),
            'error', ${JSON.stringify(error)}::jsonb,
            'delayedMs', ${delayMs}::integer
          )
        )`,
        updated_at: sql`now()`,
      })
      .from(jobsTable)
      .where(
        and(
          eq(jobStepsTable.job_id, jobsTable.id),
          eq(jobStepsTable.id, stepId),
          eq(jobStepsTable.status, STEP_STATUS_ACTIVE),
          eq(jobsTable.status, JOB_STATUS_ACTIVE),
        ),
      )
      .returning({ id: jobStepsTable.id })

    return result.length > 0
  }

  /**
   * Internal method to cancel a job step.
   *
   * @returns Promise resolving to `true` if cancelled, `false` otherwise
   */
  protected async _cancelJobStep({ stepId }: CancelJobStepOptions) {
    const result = await this.db
      .update(this.tables.jobStepsActiveTable)
      .set({
        status: STEP_STATUS_CANCELLED,
        finished_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .from(this.tables.jobsActiveTable)
      .where(
        and(
          eq(this.tables.jobStepsActiveTable.job_id, this.tables.jobsActiveTable.id),
          eq(this.tables.jobStepsActiveTable.id, stepId),
          eq(this.tables.jobStepsActiveTable.status, STEP_STATUS_ACTIVE),
          or(
            eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE),
            eq(this.tables.jobsActiveTable.status, JOB_STATUS_CANCELLED),
          ),
        ),
      )
      .returning({ id: this.tables.jobStepsActiveTable.id })

    return result.length > 0
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Internal method to get a job by its ID. Does not include step information.
   */
  protected async _getJobById(jobId: string): Promise<Job | null> {
    // Try active table first
    const activeJob = await this._getJobFromTable(jobId, this.tables.jobsActiveTable)
    if (activeJob) {
      return activeJob
    }

    // Then try archive table
    return this._getJobFromTable(jobId, this.tables.jobsArchiveTable)
  }

  private async _getJobFromTable(jobId: string, jobsTable: any): Promise<Job | null> {
    const durationMs = sql<number | null>`
      CASE
        WHEN ${jobsTable.started_at} IS NOT NULL AND ${jobsTable.finished_at} IS NOT NULL
        THEN EXTRACT(EPOCH FROM (${jobsTable.finished_at} - ${jobsTable.started_at})) * 1000
        ELSE NULL
      END
    `.as('duration_ms')

    const [job] = await this.db
      .select({
        id: jobsTable.id,
        actionName: jobsTable.action_name,
        groupKey: jobsTable.group_key,
        description: jobsTable.description,
        input: jobsTable.input,
        output: jobsTable.output,
        error: jobsTable.error,
        status: jobsTable.status,
        timeoutMs: jobsTable.timeout_ms,
        expiresAt: jobsTable.expires_at,
        startedAt: jobsTable.started_at,
        finishedAt: jobsTable.finished_at,
        createdAt: jobsTable.created_at,
        updatedAt: jobsTable.updated_at,
        concurrencyLimit: jobsTable.concurrency_limit,
        concurrencyStepLimit: jobsTable.concurrency_step_limit,
        clientId: jobsTable.client_id,
        durationMs,
      })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .limit(1)

    return job ?? null
  }

  /**
   * Internal method to get all steps for a job with optional fuzzy search.
   * Steps are always ordered by created_at ASC.
   * Steps do not include output data.
   */
  protected async _getJobSteps(options: GetJobStepsOptions): Promise<GetJobStepsResult> {
    const { jobId, search } = options
    const schemaName = this.schema
    const fuzzySearch = search?.trim()

    // Single query using UNION ALL to query both active and archive tables.
    // output is only used internally by the search filter — the outer SELECT
    // excludes it so Postgres never transfers it (steps do not include output).
    // job_finished_at is not part of the step result, so it's excluded entirely.
    const steps = this._map(
      await this.db.execute<JobStep>(sql`
        SELECT s.id,
               s."jobId",
               s."parentStepId",
               s.parallel,
               s.name,
               s.status,
               s.error,
               s."startedAt",
               s."finishedAt",
               s."timeoutMs",
               s."expiresAt",
               s."retriesLimit",
               s."retriesCount",
               s."delayedMs",
               s."historyFailedAttempts",
               s."createdAt",
               s."updatedAt"
        FROM (
          SELECT id,
                 job_id as "jobId",
                 parent_step_id as "parentStepId",
                 parallel,
                 name,
                 status,
                 output,
                 error,
                 started_at as "startedAt",
                 finished_at as "finishedAt",
                 timeout_ms as "timeoutMs",
                 expires_at as "expiresAt",
                 retries_limit as "retriesLimit",
                 retries_count as "retriesCount",
                 delayed_ms as "delayedMs",
                 history_failed_attempts as "historyFailedAttempts",
                 created_at as "createdAt",
                 updated_at as "updatedAt"
          FROM ${sql.identifier(schemaName)}.job_steps_active
          WHERE job_id = ${jobId}
          UNION ALL
          SELECT id,
                 job_id as "jobId",
                 parent_step_id as "parentStepId",
                 parallel,
                 name,
                 status,
                 output,
                 error,
                 started_at as "startedAt",
                 finished_at as "finishedAt",
                 timeout_ms as "timeoutMs",
                 expires_at as "expiresAt",
                 retries_limit as "retriesLimit",
                 retries_count as "retriesCount",
                 delayed_ms as "delayedMs",
                 history_failed_attempts as "historyFailedAttempts",
                 created_at as "createdAt",
                 updated_at as "updatedAt"
          FROM ${sql.identifier(schemaName)}.job_steps_archive
          WHERE job_id = ${jobId}
        ) s
        ${
          fuzzySearch && fuzzySearch.length > 0
            ? sql`WHERE s.name ILIKE ${`%${fuzzySearch}%`}
              OR to_tsvector('english', s.output::text) @@ plainto_tsquery('english', ${fuzzySearch})`
            : sql``
        }
        ${
          options.updatedAfter
            ? sql`${fuzzySearch && fuzzySearch.length > 0 ? sql`AND` : sql`WHERE`} date_trunc('milliseconds', s."updatedAt") > ${options.updatedAfter.toISOString()}::timestamptz`
            : sql``
        }
        ORDER BY s."createdAt" ASC
      `),
    )

    return {
      steps,
      total: steps.length,
    }
  }

  protected _buildJobsWhereClause(filters: GetJobsOptions['filters']) {
    if (!filters) {
      return undefined
    }

    const jobsTable = this.tables.jobsActiveTable

    const fuzzySearch = filters.search?.trim()

    // Build WHERE clause parts using postgres template literals
    return and(
      filters.status
        ? inArray(
            jobsTable.status,
            Array.isArray(filters.status) ? filters.status : [filters.status],
          )
        : undefined,
      filters.actionName
        ? inArray(
            jobsTable.action_name,
            Array.isArray(filters.actionName) ? filters.actionName : [filters.actionName],
          )
        : undefined,
      filters.groupKey && Array.isArray(filters.groupKey)
        ? inArray(jobsTable.group_key, filters.groupKey)
        : undefined,
      filters.groupKey && !Array.isArray(filters.groupKey)
        ? ilike(jobsTable.group_key, `%${filters.groupKey}%`)
        : undefined,
      filters.clientId
        ? inArray(
            jobsTable.client_id,
            Array.isArray(filters.clientId) ? filters.clientId : [filters.clientId],
          )
        : undefined,
      filters.description ? ilike(jobsTable.description, `%${filters.description}%`) : undefined,
      filters.createdAt && Array.isArray(filters.createdAt)
        ? between(
            sql`date_trunc('second', ${jobsTable.created_at})`,
            filters.createdAt[0]!.toISOString(),
            filters.createdAt[1]!.toISOString(),
          )
        : undefined,
      filters.createdAt && !Array.isArray(filters.createdAt)
        ? gte(sql`date_trunc('second', ${jobsTable.created_at})`, filters.createdAt.toISOString())
        : undefined,
      filters.startedAt && Array.isArray(filters.startedAt)
        ? between(
            sql`date_trunc('second', ${jobsTable.started_at})`,
            filters.startedAt[0]!.toISOString(),
            filters.startedAt[1]!.toISOString(),
          )
        : undefined,
      filters.startedAt && !Array.isArray(filters.startedAt)
        ? gte(sql`date_trunc('second', ${jobsTable.started_at})`, filters.startedAt.toISOString())
        : undefined,
      filters.finishedAt && Array.isArray(filters.finishedAt)
        ? between(
            sql`date_trunc('second', ${jobsTable.finished_at})`,
            filters.finishedAt[0]!.toISOString(),
            filters.finishedAt[1]!.toISOString(),
          )
        : undefined,
      filters.finishedAt && !Array.isArray(filters.finishedAt)
        ? gte(sql`date_trunc('second', ${jobsTable.finished_at})`, filters.finishedAt.toISOString())
        : undefined,
      filters.updatedAfter
        ? sql`date_trunc('milliseconds', ${jobsTable.updated_at}) > ${filters.updatedAfter.toISOString()}::timestamptz`
        : undefined,
      fuzzySearch && fuzzySearch.length > 0
        ? or(
            ilike(jobsTable.action_name, `%${fuzzySearch}%`),
            ilike(jobsTable.group_key, `%${fuzzySearch}%`),
            ilike(jobsTable.description, `%${fuzzySearch}%`),
            ilike(jobsTable.client_id, `%${fuzzySearch}%`),
            sql`${jobsTable.id}::text ilike ${`%${fuzzySearch}%`}`,
            sql`to_tsvector('english', ${jobsTable.input}::text) @@ plainto_tsquery('english', ${fuzzySearch})`,
            sql`to_tsvector('english', ${jobsTable.output}::text) @@ plainto_tsquery('english', ${fuzzySearch})`,
          )
        : undefined,
      ...(filters.inputFilter && Object.keys(filters.inputFilter).length > 0
        ? this.#buildJsonbWhereConditions(filters.inputFilter, jobsTable.input)
        : []),
      ...(filters.outputFilter && Object.keys(filters.outputFilter).length > 0
        ? this.#buildJsonbWhereConditions(filters.outputFilter, jobsTable.output)
        : []),
    )
  }
  /**
   * Build WHERE clause for archive jobs (same logic as active but for archive table).
   */
  protected _buildArchiveJobsWhereClause(filters: GetJobsOptions['filters']) {
    if (!filters) {
      return undefined
    }

    const archiveTable = this.tables.jobsArchiveTable

    const fuzzySearch = filters.search?.trim()

    return and(
      filters.status
        ? inArray(
            archiveTable.status,
            Array.isArray(filters.status) ? filters.status : [filters.status],
          )
        : undefined,
      filters.actionName
        ? inArray(
            archiveTable.action_name,
            Array.isArray(filters.actionName) ? filters.actionName : [filters.actionName],
          )
        : undefined,
      filters.groupKey && Array.isArray(filters.groupKey)
        ? inArray(archiveTable.group_key, filters.groupKey)
        : undefined,
      filters.groupKey && !Array.isArray(filters.groupKey)
        ? ilike(archiveTable.group_key, `%${filters.groupKey}%`)
        : undefined,
      filters.clientId
        ? inArray(
            archiveTable.client_id,
            Array.isArray(filters.clientId) ? filters.clientId : [filters.clientId],
          )
        : undefined,
      filters.description ? ilike(archiveTable.description, `%${filters.description}%`) : undefined,
      filters.createdAt && Array.isArray(filters.createdAt)
        ? between(
            sql`date_trunc('second', ${archiveTable.created_at})`,
            filters.createdAt[0]!.toISOString(),
            filters.createdAt[1]!.toISOString(),
          )
        : undefined,
      filters.createdAt && !Array.isArray(filters.createdAt)
        ? gte(
            sql`date_trunc('second', ${archiveTable.created_at})`,
            filters.createdAt.toISOString(),
          )
        : undefined,
      filters.startedAt && Array.isArray(filters.startedAt)
        ? between(
            sql`date_trunc('second', ${archiveTable.started_at})`,
            filters.startedAt[0]!.toISOString(),
            filters.startedAt[1]!.toISOString(),
          )
        : undefined,
      filters.startedAt && !Array.isArray(filters.startedAt)
        ? gte(
            sql`date_trunc('second', ${archiveTable.started_at})`,
            filters.startedAt.toISOString(),
          )
        : undefined,
      filters.finishedAt && Array.isArray(filters.finishedAt)
        ? between(
            sql`date_trunc('second', ${archiveTable.finished_at})`,
            filters.finishedAt[0]!.toISOString(),
            filters.finishedAt[1]!.toISOString(),
          )
        : undefined,
      filters.finishedAt && !Array.isArray(filters.finishedAt)
        ? gte(
            sql`date_trunc('second', ${archiveTable.finished_at})`,
            filters.finishedAt.toISOString(),
          )
        : undefined,
      filters.updatedAfter
        ? sql`date_trunc('milliseconds', ${archiveTable.updated_at}) > ${filters.updatedAfter.toISOString()}::timestamptz`
        : undefined,
      fuzzySearch
        ? or(
            ilike(archiveTable.action_name, `%${fuzzySearch}%`),
            ilike(archiveTable.group_key, `%${fuzzySearch}%`),
            ilike(archiveTable.description, `%${fuzzySearch}%`),
            ilike(archiveTable.client_id, `%${fuzzySearch}%`),
            sql`${archiveTable.id}::text ilike ${`%${fuzzySearch}%`}`,
            sql`to_tsvector('english', ${archiveTable.input}::text) @@ plainto_tsquery('english', ${fuzzySearch})`,
            sql`to_tsvector('english', ${archiveTable.output}::text) @@ plainto_tsquery('english', ${fuzzySearch})`,
          )
        : undefined,
      ...(filters.inputFilter && Object.keys(filters.inputFilter).length > 0
        ? this.#buildJsonbWhereConditions(filters.inputFilter, archiveTable.input)
        : []),
      ...(filters.outputFilter && Object.keys(filters.outputFilter).length > 0
        ? this.#buildJsonbWhereConditions(filters.outputFilter, archiveTable.output)
        : []),
    )
  }

  /**
   * Internal method to get jobs with pagination, filtering, and sorting.
   * Does not include step information or job output.
   */
  protected async _getJobs(options?: GetJobsOptions): Promise<GetJobsResult> {
    const page = options?.page ?? 1
    const pageSize = options?.pageSize ?? 10
    const filters = options?.filters ?? {}

    // Determine which table(s) to query based on status filter
    const activeStatuses = [JOB_STATUS_CREATED, JOB_STATUS_ACTIVE]
    const archiveStatuses = [JOB_STATUS_COMPLETED, JOB_STATUS_FAILED, JOB_STATUS_CANCELLED]
    const statusFilter = filters.status
    const statuses = Array.isArray(statusFilter) ? statusFilter : statusFilter ? [statusFilter] : []

    const queryActive =
      statuses.length === 0 || statuses.some((s) => (activeStatuses as string[]).includes(s))
    const queryArchive =
      statuses.length === 0 || statuses.some((s) => (archiveStatuses as string[]).includes(s))

    // Query active table
    let activeJobs: any[] = []
    let activeTotal = 0
    if (queryActive) {
      const jobsTable = this.tables.jobsActiveTable
      const where = this._buildJobsWhereClause(filters)
      activeTotal = await this.db.$count(jobsTable, where)

      if (activeTotal > 0) {
        const durationMs = sql<number | null>`
          CASE
            WHEN ${jobsTable.started_at} IS NOT NULL AND ${jobsTable.finished_at} IS NOT NULL
            THEN EXTRACT(EPOCH FROM (${jobsTable.finished_at} - ${jobsTable.started_at})) * 1000
            ELSE NULL
          END
        `.as('duration_ms')

        activeJobs = await this.db
          .select({
            id: jobsTable.id,
            actionName: jobsTable.action_name,
            groupKey: jobsTable.group_key,
            description: jobsTable.description,
            input: jobsTable.input,
            output: jobsTable.output,
            error: jobsTable.error,
            status: jobsTable.status,
            timeoutMs: jobsTable.timeout_ms,
            expiresAt: jobsTable.expires_at,
            startedAt: jobsTable.started_at,
            finishedAt: jobsTable.finished_at,
            createdAt: jobsTable.created_at,
            updatedAt: jobsTable.updated_at,
            concurrencyLimit: jobsTable.concurrency_limit,
            concurrencyStepLimit: jobsTable.concurrency_step_limit,
            clientId: jobsTable.client_id,
            durationMs,
          })
          .from(jobsTable)
          .where(where)
          .orderBy(desc(jobsTable.created_at))
          .limit(pageSize)
          .offset((page - 1) * pageSize)
      }
    }

    // Query archive table
    let archiveJobs: any[] = []
    let archiveTotal = 0
    if (queryArchive) {
      const archiveTable = this.tables.jobsArchiveTable
      // Build where clause for archive (similar to active but using archive table)
      const archiveWhere = this._buildArchiveJobsWhereClause(filters)
      archiveTotal = await this.db.$count(archiveTable, archiveWhere)

      if (archiveTotal > 0) {
        const durationMs = sql<number | null>`
          CASE
            WHEN ${archiveTable.started_at} IS NOT NULL AND ${archiveTable.finished_at} IS NOT NULL
            THEN EXTRACT(EPOCH FROM (${archiveTable.finished_at} - ${archiveTable.started_at})) * 1000
            ELSE NULL
          END
        `.as('duration_ms')

        archiveJobs = await this.db
          .select({
            id: archiveTable.id,
            actionName: archiveTable.action_name,
            groupKey: archiveTable.group_key,
            description: archiveTable.description,
            input: archiveTable.input,
            output: archiveTable.output,
            error: archiveTable.error,
            status: archiveTable.status,
            timeoutMs: archiveTable.timeout_ms,
            expiresAt: archiveTable.expires_at,
            startedAt: archiveTable.started_at,
            finishedAt: archiveTable.finished_at,
            createdAt: archiveTable.created_at,
            updatedAt: archiveTable.updated_at,
            concurrencyLimit: archiveTable.concurrency_limit,
            concurrencyStepLimit: archiveTable.concurrency_step_limit,
            clientId: archiveTable.client_id,
            durationMs,
          })
          .from(archiveTable)
          .where(archiveWhere)
          .orderBy(desc(archiveTable.created_at))
          .limit(pageSize)
          .offset((page - 1) * pageSize)
      }
    }

    // Combine results
    const allJobs = [...activeJobs, ...archiveJobs]
    const total = activeTotal + archiveTotal

    // Sort combined results
    const sortInput = options?.sort ?? { field: 'startedAt', order: 'desc' }
    const sorts = Array.isArray(sortInput) ? sortInput : [sortInput]

    allJobs.sort((a, b) => {
      for (const sort of sorts) {
        const field = sort.field
        const order = sort.order.toUpperCase() === 'ASC' ? 1 : -1
        const aVal = a[field]
        const bVal = b[field]

        if (aVal === null && bVal === null) continue
        if (aVal === null) return order
        if (bVal === null) return -order

        if (aVal < bVal) return -order
        if (aVal > bVal) return order
      }
      return 0
    })

    // Apply pagination
    const paginatedJobs = allJobs.slice(0, pageSize)

    return {
      jobs: paginatedJobs,
      total,
      page,
      pageSize,
    }
  }

  /**
   * Internal method to get a step by its ID with all information.
   */
  protected async _getJobStepById(stepId: string): Promise<JobStep | null> {
    // Try active table first
    const [activeStep] = await this.db
      .select({
        id: this.tables.jobStepsActiveTable.id,
        jobId: this.tables.jobStepsActiveTable.job_id,
        parentStepId: this.tables.jobStepsActiveTable.parent_step_id,
        parallel: this.tables.jobStepsActiveTable.parallel,
        name: this.tables.jobStepsActiveTable.name,
        output: this.tables.jobStepsActiveTable.output,
        status: this.tables.jobStepsActiveTable.status,
        error: this.tables.jobStepsActiveTable.error,
        startedAt: this.tables.jobStepsActiveTable.started_at,
        finishedAt: this.tables.jobStepsActiveTable.finished_at,
        timeoutMs: this.tables.jobStepsActiveTable.timeout_ms,
        expiresAt: this.tables.jobStepsActiveTable.expires_at,
        retriesLimit: this.tables.jobStepsActiveTable.retries_limit,
        retriesCount: this.tables.jobStepsActiveTable.retries_count,
        delayedMs: this.tables.jobStepsActiveTable.delayed_ms,
        historyFailedAttempts: this.tables.jobStepsActiveTable.history_failed_attempts,
        createdAt: this.tables.jobStepsActiveTable.created_at,
        updatedAt: this.tables.jobStepsActiveTable.updated_at,
      })
      .from(this.tables.jobStepsActiveTable)
      .where(eq(this.tables.jobStepsActiveTable.id, stepId))
      .limit(1)

    if (activeStep) {
      return activeStep
    }

    // Try archive table
    const [archiveStep] = await this.db
      .select({
        id: this.tables.jobStepsArchiveTable.id,
        jobId: this.tables.jobStepsArchiveTable.job_id,
        parentStepId: this.tables.jobStepsArchiveTable.parent_step_id,
        parallel: this.tables.jobStepsArchiveTable.parallel,
        name: this.tables.jobStepsArchiveTable.name,
        output: this.tables.jobStepsArchiveTable.output,
        status: this.tables.jobStepsArchiveTable.status,
        error: this.tables.jobStepsArchiveTable.error,
        startedAt: this.tables.jobStepsArchiveTable.started_at,
        finishedAt: this.tables.jobStepsArchiveTable.finished_at,
        timeoutMs: this.tables.jobStepsArchiveTable.timeout_ms,
        expiresAt: this.tables.jobStepsArchiveTable.expires_at,
        retriesLimit: this.tables.jobStepsArchiveTable.retries_limit,
        retriesCount: this.tables.jobStepsArchiveTable.retries_count,
        delayedMs: this.tables.jobStepsArchiveTable.delayed_ms,
        historyFailedAttempts: this.tables.jobStepsArchiveTable.history_failed_attempts,
        createdAt: this.tables.jobStepsArchiveTable.created_at,
        updatedAt: this.tables.jobStepsArchiveTable.updated_at,
      })
      .from(this.tables.jobStepsArchiveTable)
      .where(eq(this.tables.jobStepsArchiveTable.id, stepId))
      .limit(1)

    return archiveStep ?? null
  }

  /**
   * Internal method to get job status and updatedAt timestamp.
   */
  protected async _getJobStatus(jobId: string): Promise<JobStatusResult | null> {
    // Try active table first
    const [activeJob] = await this.db
      .select({
        status: this.tables.jobsActiveTable.status,
        updatedAt: this.tables.jobsActiveTable.updated_at,
      })
      .from(this.tables.jobsActiveTable)
      .where(eq(this.tables.jobsActiveTable.id, jobId))
      .limit(1)

    if (activeJob) {
      return activeJob
    }

    // Try archive table
    const [archiveJob] = await this.db
      .select({
        status: this.tables.jobsArchiveTable.status,
        updatedAt: this.tables.jobsArchiveTable.updated_at,
      })
      .from(this.tables.jobsArchiveTable)
      .where(eq(this.tables.jobsArchiveTable.id, jobId))
      .limit(1)

    return archiveJob ?? null
  }

  /**
   * Internal method to get job step status and updatedAt timestamp.
   */
  protected async _getJobStepStatus(stepId: string): Promise<JobStepStatusResult | null> {
    // Try active table first
    const [activeStep] = await this.db
      .select({
        status: this.tables.jobStepsActiveTable.status,
        updatedAt: this.tables.jobStepsActiveTable.updated_at,
      })
      .from(this.tables.jobStepsActiveTable)
      .where(eq(this.tables.jobStepsActiveTable.id, stepId))
      .limit(1)

    if (activeStep) {
      return activeStep
    }

    // Try archive table
    const [archiveStep] = await this.db
      .select({
        status: this.tables.jobStepsArchiveTable.status,
        updatedAt: this.tables.jobStepsArchiveTable.updated_at,
      })
      .from(this.tables.jobStepsArchiveTable)
      .where(eq(this.tables.jobStepsArchiveTable.id, stepId))
      .limit(1)

    return archiveStep ?? null
  }

  /**
   * Internal method to get action statistics including counts and last job created date.
   */
  protected async _getActions(): Promise<GetActionsResult> {
    const schemaName = this.schema
    const result = this._map(
      await this.db.execute<{
        name: string
        last_job_created: Date | null
        active: number
        completed: number
        failed: number
        cancelled: number
      }>(sql`
        WITH combined_jobs AS (
          SELECT action_name, status, created_at
          FROM ${sql.identifier(schemaName)}.jobs_active
          UNION ALL
          SELECT action_name, status, created_at
          FROM ${sql.identifier(schemaName)}.jobs_archive
        )
        SELECT
          action_name AS name,
          MAX(created_at) AS last_job_created,
          COUNT(*) FILTER (WHERE status = ${JOB_STATUS_ACTIVE})::int AS active,
          COUNT(*) FILTER (WHERE status = ${JOB_STATUS_COMPLETED})::int AS completed,
          COUNT(*) FILTER (WHERE status = ${JOB_STATUS_FAILED})::int AS failed,
          COUNT(*) FILTER (WHERE status = ${JOB_STATUS_CANCELLED})::int AS cancelled
        FROM combined_jobs
        GROUP BY action_name
        ORDER BY action_name
      `),
    )

    return {
      actions: (
        result as Array<{
          name: string
          last_job_created: Date | null
          active: number
          completed: number
          failed: number
          cancelled: number
        }>
      ).map((action) => ({
        name: action.name,
        lastJobCreated: action.last_job_created ?? null,
        active: action.active,
        completed: action.completed,
        failed: action.failed,
        cancelled: action.cancelled,
      })),
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Build WHERE conditions for JSONB filter using individual property checks.
   * Each property becomes a separate condition using ->> operator and ILIKE for case-insensitive matching.
   * Supports nested properties via dot notation and arrays.
   *
   * Example:
   *   { "email": "tincho@gmail", "address.name": "nicolas", "products": ["chicle"] }
   *   Generates:
   *     input ->> 'email' ILIKE '%tincho@gmail%'
   *     AND input ->> 'address' ->> 'name' ILIKE '%nicolas%'
   *     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(input -> 'products') AS elem WHERE LOWER(elem) ILIKE LOWER('%chicle%'))
   *
   * @param filter - Flat record with dot-notation keys (e.g., { "email": "test", "address.name": "value", "products": ["chicle"] })
   * @param jsonbColumn - The JSONB column name
   * @returns Array of SQL conditions
   */
  #buildJsonbWhereConditions(filter: Record<string, any>, jsonbColumn: PgColumn): any[] {
    const conditions: any[] = []

    for (const [key, value] of Object.entries(filter)) {
      const parts = key.split('.').filter((p) => p.length > 0)
      if (parts.length === 0) {
        continue
      }

      // Build the JSONB path expression step by step
      // For "address.name": input -> 'address' ->> 'name'  (-> for intermediate, ->> for final)
      // For "email": input ->> 'email'  (->> for single level)
      let jsonbPath = sql`${jsonbColumn}`
      if (parts.length === 1) {
        // Single level: use ->> directly
        jsonbPath = sql`${jsonbPath} ->> ${parts[0]!}`
      } else {
        // Nested: use -> for intermediate steps, ->> for final step
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i]
          if (part) {
            jsonbPath = sql`${jsonbPath} -> ${part}`
          }
        }
        const lastPart = parts[parts.length - 1]
        if (lastPart) {
          jsonbPath = sql`${jsonbPath} ->> ${lastPart}`
        }
      }

      // Handle array values - check if JSONB array contains at least one of the values
      if (Array.isArray(value)) {
        // Build condition: check if any element in the JSONB array matches any value in the filter array
        const arrayValueConditions = value.map((arrayValue) => {
          const arrayValueStr = String(arrayValue)
          // Get the array from JSONB: input -> 'products'
          let arrayPath = sql`${jsonbColumn}`
          for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i]
            if (part) {
              arrayPath = sql`${arrayPath} -> ${part}`
            }
          }
          const lastPart = parts[parts.length - 1]
          if (lastPart) {
            arrayPath = sql`${arrayPath} -> ${lastPart}`
          }

          // Check if the JSONB array contains the value (case-insensitive for strings)
          if (typeof arrayValue === 'string') {
            return sql`EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(${arrayPath}) AS elem
              WHERE LOWER(elem) ILIKE LOWER(${`%${arrayValueStr}%`})
            )`
          } else {
            // For non-string values, use exact containment
            // Note: JSON.stringify is safe here because drizzle-orm parameterizes the value
            return sql`${arrayPath} @> ${JSON.stringify([arrayValue])}::jsonb`
          }
        })

        // Combine array conditions with OR (at least one must match)
        if (arrayValueConditions.length > 0) {
          conditions.push(
            arrayValueConditions.reduce((acc, condition, idx) =>
              idx === 0 ? condition : sql`${acc} OR ${condition}`,
            ),
          )
        }
      } else if (typeof value === 'string') {
        // String values: use ILIKE for case-insensitive partial matching
        conditions.push(sql`COALESCE(${jsonbPath}, '') ILIKE ${`%${value}%`}`)
      } else {
        // Non-string, non-array values: use exact match
        // Convert JSONB value to text for comparison
        conditions.push(sql`${jsonbPath}::text = ${String(value)}`)
      }
    }

    return conditions
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  /**
   * Send a PostgreSQL notification.
   *
   * @param event - The event name
   * @param data - The data to send
   * @returns Promise resolving to `void`
   */
  protected async _notify(_event: string, _data: any): Promise<void> {
    // do nothing
  }

  /**
   * Listen for PostgreSQL notifications.
   *
   * @param event - The event name to listen for
   * @param callback - Callback function to handle notifications
   * @returns Promise resolving to an object with an `unlisten` function
   */
  protected async _listen(
    _event: string,
    _callback: (payload: string) => void,
  ): Promise<{ unlisten: () => void }> {
    // do nothing
    return {
      unlisten: () => {
        // do nothing
      },
    }
  }

  /**
   * Map database query results to the expected format.
   * Can be overridden by subclasses to handle different result formats.
   *
   * @param result - The raw database query result
   * @returns The mapped result
   */
  protected _map(result: any) {
    return result
  }

  // ============================================================================
  // Archive Methods (Stub implementations - to be filled in)
  // ============================================================================
  // Archive Methods
  // ============================================================================

  /**
   * Parse olderThan option into a Date threshold.
   * Supports: string (e.g. "7d", "1h"), Date, or number (timestamp ms).
   */
  private _parseOlderThan(olderThan: string | Date | number): Date {
    if (olderThan instanceof Date) {
      return olderThan
    }

    if (typeof olderThan === 'number') {
      return new Date(olderThan)
    }

    // Parse duration string like "7d", "1h", "30m", "10s", "500ms"
    const match = olderThan.match(/^(\d+)\s*(ms|d|h|m|s)$/i)
    if (!match) {
      throw new Error(
        `Invalid olderThan format: ${olderThan}. Expected: "7d", "1h", "30m", "10s", "500ms", Date, or number`,
      )
    }

    const value = parseInt(match[1]!, 10)
    const unit = match[2]!.toLowerCase()
    const now = Date.now()

    const multipliers: Record<string, number> = {
      d: 24 * 60 * 60 * 1000,
      h: 60 * 60 * 1000,
      m: 60 * 1000,
      s: 1000,
      ms: 1,
    }

    const ms = value * (multipliers[unit] ?? 0)
    return new Date(now - ms)
  }

  protected async _pruneArchive(options: PruneArchiveOptions): Promise<number> {
    const threshold = this._parseOlderThan(options.olderThan)
    const batchSize = options.batchSize ?? 1000
    const maxBatches = options.maxBatches ?? 100
    const schemaName = this.schema

    let totalDeleted = 0

    for (let batch = 0; batch < maxBatches; batch++) {
      const result = this._map(
        await this.db.execute<{ id: string }>(sql`
          WITH ids_to_delete AS (
            SELECT id FROM ${sql.identifier(schemaName)}.jobs_archive
            WHERE finished_at < ${threshold.toISOString()}
            LIMIT ${batchSize}
          )
          DELETE FROM ${sql.identifier(schemaName)}.jobs_archive j
          USING ids_to_delete d
          WHERE j.id = d.id
          RETURNING j.id
        `),
      )

      if (!result || result.length === 0) {
        break
      }

      totalDeleted += result.length
    }

    return totalDeleted
  }

  protected async _truncateArchive(): Promise<void> {
    const schemaName = this.schema
    await this.db.execute(sql`TRUNCATE TABLE ${sql.identifier(schemaName)}.jobs_archive CASCADE`)
  }

  protected async _getArchiveStats(): Promise<ArchiveStats> {
    const schemaName = this.schema

    const [jobsResult, stepsResult, oldestResult] = await Promise.all([
      this.db
        .execute<{ count: number }>(sql`
        SELECT COUNT(*)::int as count FROM ${sql.identifier(schemaName)}.jobs_archive
      `)
        .then((r) => this._map(r)),
      this.db
        .execute<{ count: number }>(sql`
        SELECT COUNT(*)::int as count FROM ${sql.identifier(schemaName)}.job_steps_archive
      `)
        .then((r) => this._map(r)),
      this.db
        .execute<{ finished_at: Date | null }>(sql`
        SELECT finished_at FROM ${sql.identifier(schemaName)}.jobs_archive
        ORDER BY finished_at ASC
        LIMIT 1
      `)
        .then((r) => this._map(r)),
    ])

    const oldestDate = oldestResult[0]?.finished_at ? new Date(oldestResult[0].finished_at) : null

    return {
      jobsCount: Number(jobsResult[0]?.count ?? 0),
      stepsCount: Number(stepsResult[0]?.count ?? 0),
      oldestJobDate: oldestDate,
      totalSizeBytes: null,
      lastPrunedAt: this.lastPrunedAt,
    }
  }
}
