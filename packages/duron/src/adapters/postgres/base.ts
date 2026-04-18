import { and, asc, between, desc, eq, gt, gte, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { PgAsyncDatabase, PgColumn } from 'drizzle-orm/pg-core'

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
  type DeleteSpansOptions,
  type FailJobOptions,
  type FailJobStepOptions,
  type FetchOptions,
  type GetActionsResult,
  type GetJobStepsOptions,
  type GetJobStepsResult,
  type GetJobsOptions,
  type GetJobsResult,
  type GetSpansOptions,
  type GetSpansResult,
  type InsertSpanOptions,
  type Job,
  type JobSort,
  type JobStatusResult,
  type JobStep,
  type JobStepStatusResult,
  type RecoverJobsOptions,
  type RetryJobOptions,
  type SpanSort,
  type TimeTravelJobOptions,
} from '../adapter.js'
import createSchema from './schema.js'

type Schema = ReturnType<typeof createSchema>

// Re-export types for backward compatibility
export type { Job, JobStep } from '../adapter.js'

type DrizzleDatabase = PgAsyncDatabase<any, Schema>

export interface AdapterOptions<Connection> {
  connection: Connection
  schema?: string
  migrateOnStart?: boolean
  migrationsFolder?: string
}

export class PostgresBaseAdapter<Database extends DrizzleDatabase, Connection> extends Adapter {
  protected connection: Connection
  protected db!: Database
  protected tables: Schema
  protected schema: string = 'duron'
  protected migrateOnStart: boolean = true

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

    this.tables = createSchema(this.schema)

    this._initDb()
  }

  /**
   * Initialize the database connection and Drizzle instance.
   */
  protected _initDb() {
    throw new Error('Not implemented')
  }

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
    await this._listen(`ping-${this.id}`, async (payload: string) => {
      const fromClientId = JSON.parse(payload).fromClientId
      await this._notify(`pong-${fromClientId}`, { toClientId: this.id })
    })

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
  }

  protected async _stop() {
    // do nothing
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
      // 1. Delete job from active and get its data
      const movedJob = await tx
        .delete(this.tables.jobsActiveTable)
        .where(
          and(
            eq(this.tables.jobsActiveTable.id, jobId),
            eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE),
            eq(this.tables.jobsActiveTable.client_id, this.id),
            gt(this.tables.jobsActiveTable.expires_at, sql`now()`),
          ),
        )
        .returning()

      if (movedJob.length === 0) {
        return false
      }

      const job = movedJob[0]!

      // 2. Delete steps from active
      const movedSteps = await tx
        .delete(this.tables.jobStepsActiveTable)
        .where(eq(this.tables.jobStepsActiveTable.job_id, jobId))
        .returning()

      // 3. Delete spans from active
      const movedSpans = await tx
        .delete(this.tables.spansActiveTable)
        .where(eq(this.tables.spansActiveTable.job_id, jobId))
        .returning()

      // 4. Insert job into archive
      await tx.insert(this.tables.jobsArchiveTable).values({
        ...job,
        status: JOB_STATUS_COMPLETED,
        output,
        finished_at: new Date(),
        updated_at: new Date(),
      })

      // 5. Insert steps into archive
      if (movedSteps.length > 0) {
        await tx.insert(this.tables.jobStepsArchiveTable).values(
          movedSteps.map((step) => ({
            ...step,
            job_finished_at: job.finished_at,
          })),
        )
      }

      // 6. Insert spans into archive
      if (movedSpans.length > 0) {
        await tx.insert(this.tables.spansArchiveTable).values(movedSpans)
      }

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
      const movedJob = await tx
        .delete(this.tables.jobsActiveTable)
        .where(
          and(
            eq(this.tables.jobsActiveTable.id, jobId),
            eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE),
            eq(this.tables.jobsActiveTable.client_id, this.id),
          ),
        )
        .returning()

      if (movedJob.length === 0) {
        return false
      }

      const job = movedJob[0]!

      const movedSteps = await tx
        .delete(this.tables.jobStepsActiveTable)
        .where(eq(this.tables.jobStepsActiveTable.job_id, jobId))
        .returning()

      const movedSpans = await tx
        .delete(this.tables.spansActiveTable)
        .where(eq(this.tables.spansActiveTable.job_id, jobId))
        .returning()

      await tx.insert(this.tables.jobsArchiveTable).values({
        ...job,
        status: JOB_STATUS_FAILED,
        error,
        finished_at: new Date(),
        updated_at: new Date(),
      })

      if (movedSteps.length > 0) {
        await tx.insert(this.tables.jobStepsArchiveTable).values(
          movedSteps.map((step) => ({
            ...step,
            job_finished_at: job.finished_at,
          })),
        )
      }

      if (movedSpans.length > 0) {
        await tx.insert(this.tables.spansArchiveTable).values(movedSpans)
      }

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
      const movedJob = await tx
        .delete(this.tables.jobsActiveTable)
        .where(
          and(
            eq(this.tables.jobsActiveTable.id, jobId),
            or(eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE), eq(this.tables.jobsActiveTable.status, JOB_STATUS_CREATED)),
          ),
        )
        .returning()

      if (movedJob.length === 0) {
        return false
      }

      const job = movedJob[0]!

      const movedSteps = await tx
        .delete(this.tables.jobStepsActiveTable)
        .where(eq(this.tables.jobStepsActiveTable.job_id, jobId))
        .returning()

      const movedSpans = await tx
        .delete(this.tables.spansActiveTable)
        .where(eq(this.tables.spansActiveTable.job_id, jobId))
        .returning()

      await tx.insert(this.tables.jobsArchiveTable).values({
        ...job,
        status: JOB_STATUS_CANCELLED,
        finished_at: new Date(),
        updated_at: new Date(),
      })

      if (movedSteps.length > 0) {
        await tx.insert(this.tables.jobStepsArchiveTable).values(
          movedSteps.map((step) => ({
            ...step,
            job_finished_at: job.finished_at,
          })),
        )
      }

      if (movedSpans.length > 0) {
        await tx.insert(this.tables.spansArchiveTable).values(movedSpans)
      }

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
    const result = this._map(
      await this.db.execute<{ success: boolean }>(sql`
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
          AND s.branch = true
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
          AND s.branch = true
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
      .where(and(eq(this.tables.jobsActiveTable.id, jobId), ne(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE)))
      .returning({ id: this.tables.jobsActiveTable.id })

    // Also delete associated steps
    if (result.length > 0) {
      await this.db.delete(this.tables.jobStepsActiveTable).where(eq(this.tables.jobStepsActiveTable.job_id, jobId))
    }

    return result.length > 0
  }

  /**
   * Internal method to delete multiple jobs using the same filters as getJobs.
   * Active jobs cannot be deleted and will be excluded from deletion.
   *
   * @returns Promise resolving to the number of jobs deleted
   */
  protected async _deleteJobs(options?: DeleteJobsOptions): Promise<number> {
    const jobsTable = this.tables.jobsActiveTable
    const filters = options?.filters ?? {}

    const where = this._buildJobsWhereClause(filters)

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
      ),
      verify_concurrency AS (
        -- Double-check concurrency limit after acquiring lock
        SELECT
          nj.id,
          nj.action_name,
          nj.job_group_key,
          eg.concurrency_limit,
          (SELECT COUNT(*)
          FROM ${this.tables.jobsActiveTable}
          WHERE action_name = nj.action_name
            AND group_key = nj.job_group_key
            AND status = ${JOB_STATUS_ACTIVE}) as current_active
        FROM next_job nj
        INNER JOIN eligible_groups eg
          ON nj.job_group_key = eg.group_key
          AND nj.action_name = eg.action_name
      )
      UPDATE ${this.tables.jobsActiveTable} j
      SET status = ${JOB_STATUS_ACTIVE},
          started_at = now(),
          expires_at = now() + (timeout_ms || ' milliseconds')::interval,
          client_id = ${this.id},
          updated_at = now()
      FROM verify_concurrency vc
      WHERE j.id = vc.id
        AND vc.current_active < vc.concurrency_limit  -- Final concurrency check using job's concurrency limit
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
   * In multi-process mode, pings other processes to check if they're alive before recovering their jobs.
   *
   * @returns Promise resolving to the number of jobs recovered
   */
  protected async _recoverJobs(options: RecoverJobsOptions): Promise<number> {
    const { checksums, multiProcessMode = false, processTimeout = 5_000 } = options

    const unresponsiveClientIds: string[] = [this.id]

    if (multiProcessMode) {
      const result = (await this.db
        .selectDistinct({
          clientId: this.tables.jobsActiveTable.client_id,
        })
        .from(this.tables.jobsActiveTable)
        .where(
          and(eq(this.tables.jobsActiveTable.status, JOB_STATUS_ACTIVE), ne(this.tables.jobsActiveTable.client_id, this.id)),
        )) as unknown as { clientId: string }[]

      if (result.length > 0) {
        const pongCount = new Set<string>()
        const { unlisten } = await this._listen(`pong-${this.id}`, (payload: string) => {
          const toClientId = JSON.parse(payload).toClientId
          pongCount.add(toClientId)
          if (pongCount.size >= result.length) {
            unlisten()
          }
        })

        await Promise.all(result.map((row) => this._notify(`ping-${row.clientId}`, { fromClientId: this.id })))

        let waitForSeconds = processTimeout / 1_000
        while (pongCount.size < result.length && waitForSeconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000).unref?.())
          waitForSeconds--
        }

        unresponsiveClientIds.push(...result.filter((row) => !pongCount.has(row.clientId)).map((row) => row.clientId))
      }
    }

    if (unresponsiveClientIds.length > 0) {
      const result = this._map(
        await this.db.execute<{ id: string }>(sql`
        WITH locked_jobs AS (
          SELECT j.id
          FROM ${this.tables.jobsActiveTable} j
          WHERE j.status = ${JOB_STATUS_ACTIVE}
            AND j.client_id IN ${unresponsiveClientIds}
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

      return result.length
    }

    return 0
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
          branch,
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
          now() + interval '${sql.raw(timeoutMs.toString())} milliseconds',
          0,
          NULL
        WHERE EXISTS (SELECT 1 FROM job_check)
        ON CONFLICT (job_id, name, parent_step_id) DO UPDATE
        SET
          timeout_ms = ${timeoutMs},
          expires_at = now() + interval '${sql.raw(timeoutMs.toString())} milliseconds',
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
          or(isNull(this.tables.jobsActiveTable.expires_at), gt(this.tables.jobsActiveTable.expires_at, sql`now()`)),
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

    // Determine if job is in active or archive table
    const jobInActive = await this.db
      .select({ id: this.tables.jobsActiveTable.id })
      .from(this.tables.jobsActiveTable)
      .where(eq(this.tables.jobsActiveTable.id, jobId))
      .limit(1)

    const isActive = jobInActive.length > 0
    const jobStepsTable = isActive ? this.tables.jobStepsActiveTable : this.tables.jobStepsArchiveTable

    const fuzzySearch = search?.trim()

    const where = and(
      eq(jobStepsTable.job_id, jobId),
      fuzzySearch && fuzzySearch.length > 0
        ? or(
            ilike(jobStepsTable.name, `%${fuzzySearch}%`),
            sql`to_tsvector('english', ${jobStepsTable.output}::text) @@ plainto_tsquery('english', ${fuzzySearch})`,
          )
        : undefined,
      options.updatedAfter
        ? sql`date_trunc('milliseconds', ${jobStepsTable.updated_at}) > ${options.updatedAfter.toISOString()}::timestamptz`
        : undefined,
    )

    const steps = await this.db
      .select({
        id: jobStepsTable.id,
        jobId: jobStepsTable.job_id,
        parentStepId: jobStepsTable.parent_step_id,
        parallel: jobStepsTable.parallel,
        name: jobStepsTable.name,
        status: jobStepsTable.status,
        error: jobStepsTable.error,
        startedAt: jobStepsTable.started_at,
        finishedAt: jobStepsTable.finished_at,
        timeoutMs: jobStepsTable.timeout_ms,
        expiresAt: jobStepsTable.expires_at,
        retriesLimit: jobStepsTable.retries_limit,
        retriesCount: jobStepsTable.retries_count,
        delayedMs: jobStepsTable.delayed_ms,
        historyFailedAttempts: jobStepsTable.history_failed_attempts,
        createdAt: jobStepsTable.created_at,
        updatedAt: jobStepsTable.updated_at,
      })
      .from(jobStepsTable)
      .where(where)
      .orderBy(asc(jobStepsTable.created_at))

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
        ? inArray(jobsTable.status, Array.isArray(filters.status) ? filters.status : [filters.status])
        : undefined,
      filters.actionName
        ? inArray(jobsTable.action_name, Array.isArray(filters.actionName) ? filters.actionName : [filters.actionName])
        : undefined,
      filters.groupKey && Array.isArray(filters.groupKey)
        ? sql`j.group_key LIKE ANY(ARRAY[${sql.raw(filters.groupKey.map((key) => `'${key}'`).join(','))}]::text[])`
        : undefined,
      filters.groupKey && !Array.isArray(filters.groupKey)
        ? ilike(jobsTable.group_key, `%${filters.groupKey}%`)
        : undefined,
      filters.clientId
        ? inArray(jobsTable.client_id, Array.isArray(filters.clientId) ? filters.clientId : [filters.clientId])
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
        ? inArray(archiveTable.status, Array.isArray(filters.status) ? filters.status : [filters.status])
        : undefined,
      filters.actionName
        ? inArray(archiveTable.action_name, Array.isArray(filters.actionName) ? filters.actionName : [filters.actionName])
        : undefined,
      filters.groupKey && Array.isArray(filters.groupKey)
        ? sql`j.group_key LIKE ANY(ARRAY[${sql.raw(filters.groupKey.map((key) => `'${key}'`).join(','))}]::text[])`
        : undefined,
      filters.groupKey && !Array.isArray(filters.groupKey)
        ? ilike(archiveTable.group_key, `%${filters.groupKey}%`)
        : undefined,
      filters.clientId
        ? inArray(archiveTable.client_id, Array.isArray(filters.clientId) ? filters.clientId : [filters.clientId])
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
        ? gte(sql`date_trunc('second', ${archiveTable.created_at})`, filters.createdAt.toISOString())
        : undefined,
      filters.startedAt && Array.isArray(filters.startedAt)
        ? between(
            sql`date_trunc('second', ${archiveTable.started_at})`,
            filters.startedAt[0]!.toISOString(),
            filters.startedAt[1]!.toISOString(),
          )
        : undefined,
      filters.startedAt && !Array.isArray(filters.startedAt)
        ? gte(sql`date_trunc('second', ${archiveTable.started_at})`, filters.startedAt.toISOString())
        : undefined,
      filters.finishedAt && Array.isArray(filters.finishedAt)
        ? between(
            sql`date_trunc('second', ${archiveTable.finished_at})`,
            filters.finishedAt[0]!.toISOString(),
            filters.finishedAt[1]!.toISOString(),
          )
        : undefined,
      filters.finishedAt && !Array.isArray(filters.finishedAt)
        ? gte(sql`date_trunc('second', ${archiveTable.finished_at})`, filters.finishedAt.toISOString())
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

    const queryActive = statuses.length === 0 || statuses.some(s => (activeStatuses as string[]).includes(s))
    const queryArchive = statuses.length === 0 || statuses.some(s => (archiveStatuses as string[]).includes(s))

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
    const actionStats = this.db.$with('action_stats').as(
      this.db
        .select({
          name: this.tables.jobsActiveTable.action_name,
          last_job_created: sql<Date | null>`MAX(${this.tables.jobsActiveTable.created_at})`.as('last_job_created'),
          active: sql<number>`COUNT(*) FILTER (WHERE ${this.tables.jobsActiveTable.status} = ${JOB_STATUS_ACTIVE})`.as(
            'active',
          ),
          completed: sql<number>`COUNT(*) FILTER (WHERE ${this.tables.jobsActiveTable.status} = ${JOB_STATUS_COMPLETED})`.as(
            'completed',
          ),
          failed: sql<number>`COUNT(*) FILTER (WHERE ${this.tables.jobsActiveTable.status} = ${JOB_STATUS_FAILED})`.as(
            'failed',
          ),
          cancelled: sql<number>`COUNT(*) FILTER (WHERE ${this.tables.jobsActiveTable.status} = ${JOB_STATUS_CANCELLED})`.as(
            'cancelled',
          ),
        })
        .from(this.tables.jobsActiveTable)
        .groupBy(this.tables.jobsActiveTable.action_name),
    )

    const actions = await this.db
      .with(actionStats)
      .select({
        name: actionStats.name,
        lastJobCreated: actionStats.last_job_created,
        active: sql<number>`${actionStats.active}::int`,
        completed: sql<number>`${actionStats.completed}::int`,
        failed: sql<number>`${actionStats.failed}::int`,
        cancelled: sql<number>`${actionStats.cancelled}::int`,
      })
      .from(actionStats)
      .orderBy(actionStats.name)

    return {
      actions: actions.map((action) => ({
        ...action,
        lastJobCreated: action.lastJobCreated ?? null,
      })),
    }
  }

  // ============================================================================
  // Metrics Methods
  // ============================================================================

  /**
   * Internal method to insert multiple span records in a single batch.
   */
  protected async _insertSpans(spans: InsertSpanOptions[]): Promise<number> {
    if (spans.length === 0) {
      return 0
    }

    const values = spans.map((s) => ({
      trace_id: s.traceId,
      span_id: s.spanId,
      parent_span_id: s.parentSpanId,
      job_id: s.jobId,
      step_id: s.stepId,
      name: s.name,
      kind: s.kind,
      start_time_unix_nano: s.startTimeUnixNano,
      end_time_unix_nano: s.endTimeUnixNano,
      status_code: s.statusCode,
      status_message: s.statusMessage,
      attributes: s.attributes ?? {},
      events: s.events ?? [],
    }))

    const result = await this.db
      .insert(this.tables.spansActiveTable)
      .values(values)
      .returning({ id: this.tables.spansActiveTable.id })

    return result.length
  }

  /**
   * Internal method to get spans for a job or step.
   * For step queries, uses a recursive CTE to find all descendant spans.
   */
  protected async _getSpans(options: GetSpansOptions): Promise<GetSpansResult> {
    const filters = options.filters ?? {}

    // Build sort
    const sortInput = options.sort ?? { field: 'startTimeUnixNano', order: 'asc' }
    const sortFieldMap: Record<SpanSort['field'], string> = {
      name: 'name',
      startTimeUnixNano: 'start_time_unix_nano',
      endTimeUnixNano: 'end_time_unix_nano',
    }
    const sortField = sortFieldMap[sortInput.field]
    const sortOrder = sortInput.order === 'asc' ? 'ASC' : 'DESC'

    // For step queries, use a recursive CTE to get descendant spans
    if (options.stepId) {
      return this._getStepSpansRecursive(options.stepId, sortField, sortOrder, filters)
    }

    // Determine if job is active or archived
    let isActive = true
    if (options.jobId) {
      const jobInActive = await this.db
        .select({ id: this.tables.jobsActiveTable.id })
        .from(this.tables.jobsActiveTable)
        .where(eq(this.tables.jobsActiveTable.id, options.jobId))
        .limit(1)
      isActive = jobInActive.length > 0
    }

    const spansTable = isActive ? this.tables.spansActiveTable : this.tables.spansArchiveTable

    // Build WHERE clause for job queries
    const where = this._buildSpansWhereClause(options.jobId, undefined, filters, isActive)

    // Get total count
    const total = await this.db.$count(spansTable, where)
    if (!total) {
      return {
        spans: [],
        total: 0,
      }
    }

    const sortFieldColumn = sortFieldMap[sortInput.field]
    const orderByClause =
      sortInput.order === 'asc'
        ? asc(spansTable[sortFieldColumn as keyof typeof spansTable] as any)
        : desc(spansTable[sortFieldColumn as keyof typeof spansTable] as any)

    const rows = await this.db
      .select({
        id: spansTable.id,
        traceId: spansTable.trace_id,
        spanId: spansTable.span_id,
        parentSpanId: spansTable.parent_span_id,
        jobId: spansTable.job_id,
        stepId: spansTable.step_id,
        name: spansTable.name,
        kind: spansTable.kind,
        startTimeUnixNano: spansTable.start_time_unix_nano,
        endTimeUnixNano: spansTable.end_time_unix_nano,
        statusCode: spansTable.status_code,
        statusMessage: spansTable.status_message,
        attributes: spansTable.attributes,
        events: spansTable.events,
      })
      .from(spansTable)
      .where(where)
      .orderBy(orderByClause)

    // Cast kind and statusCode to proper types, convert BigInt to string for JSON serialization
    const spans = rows.map((row) => ({
      ...row,
      kind: row.kind as 0 | 1 | 2 | 3 | 4,
      statusCode: row.statusCode as 0 | 1 | 2,
      // Convert BigInt to string for JSON serialization
      startTimeUnixNano: row.startTimeUnixNano?.toString() ?? null,
      endTimeUnixNano: row.endTimeUnixNano?.toString() ?? null,
    }))

    return {
      spans,
      total,
    }
  }

  /**
   * Get spans for a step using a recursive CTE to traverse the span hierarchy.
   * This returns the step's span and all its descendant spans (children, grandchildren, etc.)
   */
  protected async _getStepSpansRecursive(
    stepId: string,
    sortField: string,
    sortOrder: string,
    _filters?: GetSpansOptions['filters'],
  ): Promise<GetSpansResult> {
    const schemaName = this.schema

    // Query both active and archive spans tables
    const query = sql`
      WITH RECURSIVE span_tree AS (
        -- Base case: the span(s) for the step (check both tables)
        SELECT * FROM ${sql.identifier(schemaName)}.spans_active WHERE step_id = ${stepId}::uuid
        UNION
        SELECT * FROM ${sql.identifier(schemaName)}.spans_archive WHERE step_id = ${stepId}::uuid
        UNION ALL
        -- Recursive case: children of spans we've found (check both tables)
        SELECT s.* FROM ${sql.identifier(schemaName)}.spans_active s
        INNER JOIN span_tree st ON s.parent_span_id = st.span_id
        UNION
        SELECT s.* FROM ${sql.identifier(schemaName)}.spans_archive s
        INNER JOIN span_tree st ON s.parent_span_id = st.span_id
      )
      SELECT
        id,
        trace_id as "traceId",
        span_id as "spanId",
        parent_span_id as "parentSpanId",
        job_id as "jobId",
        step_id as "stepId",
        name,
        kind,
        start_time_unix_nano as "startTimeUnixNano",
        end_time_unix_nano as "endTimeUnixNano",
        status_code as "statusCode",
        status_message as "statusMessage",
        attributes,
        events
      FROM span_tree
      ORDER BY ${sql.identifier(sortField)} ${sql.raw(sortOrder)}
    `

    // Raw SQL returns numeric types as strings, so we type them as such
    const rows = (await this.db.execute(query)) as unknown as Array<{
      id: string | number
      traceId: string
      spanId: string
      parentSpanId: string | null
      jobId: string | null
      stepId: string | null
      name: string
      kind: string | number
      startTimeUnixNano: string | bigint | null
      endTimeUnixNano: string | bigint | null
      statusCode: string | number
      statusMessage: string | null
      attributes: Record<string, any>
      events: Array<{ name: string; timeUnixNano: string; attributes?: Record<string, any> }>
    }>

    // Convert types: raw SQL returns numeric types as strings
    const spans = rows.map((row) => ({
      ...row,
      // Convert id to number (bigserial comes as string from raw SQL)
      id: typeof row.id === 'string' ? Number.parseInt(row.id, 10) : row.id,
      // Convert kind and statusCode to proper types
      kind: (typeof row.kind === 'string' ? Number.parseInt(row.kind, 10) : row.kind) as 0 | 1 | 2 | 3 | 4,
      statusCode: (typeof row.statusCode === 'string' ? Number.parseInt(row.statusCode, 10) : row.statusCode) as
        | 0
        | 1
        | 2,
      // Convert BigInt to string for JSON serialization
      startTimeUnixNano: row.startTimeUnixNano?.toString() ?? null,
      endTimeUnixNano: row.endTimeUnixNano?.toString() ?? null,
    }))

    return {
      spans,
      total: spans.length,
    }
  }

  /**
   * Internal method to delete all spans for a job.
   */
  protected async _deleteSpans(options: DeleteSpansOptions): Promise<number> {
    // Delete from both tables to be safe
    const activeResult = await this.db
      .delete(this.tables.spansActiveTable)
      .where(eq(this.tables.spansActiveTable.job_id, options.jobId))
      .returning({ id: this.tables.spansActiveTable.id })

    const archiveResult = await this.db
      .delete(this.tables.spansArchiveTable)
      .where(eq(this.tables.spansArchiveTable.job_id, options.jobId))
      .returning({ id: this.tables.spansArchiveTable.id })

    return activeResult.length + archiveResult.length
  }

  /**
   * Build WHERE clause for spans queries (used for job queries only).
   * When querying by jobId, we find all spans that share the same trace_id
   * as spans with that job. This includes spans from external libraries that
   * don't have the duron.job.id attribute but are part of the same trace.
   *
   * Note: Step queries are handled separately by _getStepSpansRecursive using
   * a recursive CTE to traverse the span hierarchy.
   */
  protected _buildSpansWhereClause(jobId?: string, _stepId?: string, filters?: GetSpansOptions['filters'], isActive: boolean = true) {
    const spansTable = isActive ? this.tables.spansActiveTable : this.tables.spansArchiveTable

    // Build condition for finding spans by trace_id (includes external spans)
    let traceCondition: ReturnType<typeof eq> | undefined

    if (jobId) {
      // Find all spans that share a trace_id with any span that has this job_id
      // This includes external spans (like from AI SDK) that don't have duron.job.id
      traceCondition = inArray(
        spansTable.trace_id,
        this.db.select({ traceId: spansTable.trace_id }).from(spansTable).where(eq(spansTable.job_id, jobId)),
      )
    }

    return and(
      traceCondition,
      filters?.name
        ? Array.isArray(filters.name)
          ? or(...filters.name.map((n) => ilike(spansTable.name, `%${n}%`)))
          : ilike(spansTable.name, `%${filters.name}%`)
        : undefined,
      filters?.kind ? inArray(spansTable.kind, Array.isArray(filters.kind) ? filters.kind : [filters.kind]) : undefined,
      filters?.statusCode
        ? inArray(spansTable.status_code, Array.isArray(filters.statusCode) ? filters.statusCode : [filters.statusCode])
        : undefined,
      filters?.traceId ? eq(spansTable.trace_id, filters.traceId) : undefined,
      ...(filters?.attributesFilter && Object.keys(filters.attributesFilter).length > 0
        ? this.#buildJsonbWhereConditions(filters.attributesFilter, spansTable.attributes)
        : []),
    )
  }

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
            return sql`${arrayPath} @> ${sql.raw(JSON.stringify([arrayValue]))}::jsonb`
          }
        })

        // Combine array conditions with OR (at least one must match)
        if (arrayValueConditions.length > 0) {
          conditions.push(
            arrayValueConditions.reduce((acc, condition, idx) => (idx === 0 ? condition : sql`${acc} OR ${condition}`)),
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
  protected async _listen(_event: string, _callback: (payload: string) => void): Promise<{ unlisten: () => void }> {
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

  protected async _pruneArchive(_options: any): Promise<number> {
    return 0
  }

  protected async _truncateArchive(): Promise<void> {
    // TODO: Implement
  }

  protected async _getArchiveStats(): Promise<any> {
    return {
      jobsCount: 0,
      stepsCount: 0,
      spansCount: 0,
      oldestJobDate: null,
      totalSizeBytes: null,
      lastPrunedAt: null,
    }
  }
}
