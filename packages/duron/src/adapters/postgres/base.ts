import { and, asc, between, desc, eq, gt, gte, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { PgColumn, PgDatabase } from 'drizzle-orm/pg-core'

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
  type FailJobOptions,
  type FailJobStepOptions,
  type FetchOptions,
  type GetActionsResult,
  type GetJobStepsOptions,
  type GetJobStepsResult,
  type GetJobsOptions,
  type GetJobsResult,
  type Job,
  type JobSort,
  type JobStatusResult,
  type JobStep,
  type JobStepStatusResult,
  type RecoverJobsOptions,
  type RetryJobOptions,
} from '../adapter.js'
import createSchema from './schema.js'

type Schema = ReturnType<typeof createSchema>

// Re-export types for backward compatibility
export type { Job, JobStep } from '../adapter.js'

type DrizzleDatabase = PgDatabase<any, Schema>

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
  protected async _createJob({ queue, groupKey, input, timeoutMs, checksum, concurrencyLimit }: CreateJobOptions) {
    const [result] = await this.db
      .insert(this.tables.jobsTable)
      .values({
        action_name: queue,
        group_key: groupKey,
        checksum,
        input,
        status: JOB_STATUS_CREATED,
        timeout_ms: timeoutMs,
        concurrency_limit: concurrencyLimit,
      })
      .returning({ id: this.tables.jobsTable.id })

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
    const result = await this.db
      .update(this.tables.jobsTable)
      .set({
        status: JOB_STATUS_COMPLETED,
        output,
        finished_at: sql`now()`,
      })
      .where(
        and(
          eq(this.tables.jobsTable.id, jobId),
          eq(this.tables.jobsTable.status, JOB_STATUS_ACTIVE),
          eq(this.tables.jobsTable.client_id, this.id),
          gt(this.tables.jobsTable.expires_at, sql`now()`),
        ),
      )
      .returning({ id: this.tables.jobsTable.id })

    return result.length > 0
  }

  /**
   * Internal method to mark a job as failed.
   *
   * @returns Promise resolving to `true` if failed, `false` otherwise
   */
  protected async _failJob({ jobId, error }: FailJobOptions) {
    const result = await this.db
      .update(this.tables.jobsTable)
      .set({
        status: JOB_STATUS_FAILED,
        error,
        finished_at: sql`now()`,
      })
      .where(
        and(
          eq(this.tables.jobsTable.id, jobId),
          eq(this.tables.jobsTable.status, JOB_STATUS_ACTIVE),
          eq(this.tables.jobsTable.client_id, this.id),
        ),
      )
      .returning({ id: this.tables.jobsTable.id })

    return result.length > 0
  }

  /**
   * Internal method to cancel a job.
   *
   * @returns Promise resolving to `true` if cancelled, `false` otherwise
   */
  protected async _cancelJob({ jobId }: CancelJobOptions) {
    const result = await this.db
      .update(this.tables.jobsTable)
      .set({
        status: JOB_STATUS_CANCELLED,
        finished_at: sql`now()`,
      })
      .where(
        and(
          eq(this.tables.jobsTable.id, jobId),
          or(eq(this.tables.jobsTable.status, JOB_STATUS_ACTIVE), eq(this.tables.jobsTable.status, JOB_STATUS_CREATED)),
        ),
      )
      .returning({ id: this.tables.jobsTable.id })

    return result.length > 0
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
          j.checksum,
          j.input,
          j.timeout_ms,
          j.created_at,
          j.concurrency_limit
        FROM ${this.tables.jobsTable} j
        WHERE j.id = ${jobId}
          AND j.status IN (${JOB_STATUS_COMPLETED}, ${JOB_STATUS_CANCELLED}, ${JOB_STATUS_FAILED})
        FOR UPDATE OF j SKIP LOCKED
      ),
      existing_retry AS (
        -- Check if a retry already exists (a newer job with same checksum, group_key, and input)
        SELECT j.id
        FROM ${this.tables.jobsTable} j
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
        INSERT INTO ${this.tables.jobsTable} (
          action_name,
          group_key,
          checksum,
          input,
          status,
          timeout_ms,
          concurrency_limit
        )
        SELECT
          ls.action_name,
          ls.group_key,
          ls.checksum,
          ls.input,
          ${JOB_STATUS_CREATED},
          ls.timeout_ms,
          COALESCE(
            (
              SELECT j.concurrency_limit
              FROM ${this.tables.jobsTable} j
              WHERE j.action_name = ls.action_name
                AND j.group_key = ls.group_key
                AND (j.expires_at IS NULL OR j.expires_at > now())
              ORDER BY j.created_at DESC, j.id DESC
              LIMIT 1
            ),
            ls.concurrency_limit
          )
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
   * Internal method to delete a job by its ID.
   * Active jobs cannot be deleted.
   *
   * @returns Promise resolving to `true` if deleted, `false` otherwise
   */
  protected async _deleteJob({ jobId }: DeleteJobOptions): Promise<boolean> {
    const result = await this.db
      .delete(this.tables.jobsTable)
      .where(and(eq(this.tables.jobsTable.id, jobId), ne(this.tables.jobsTable.status, JOB_STATUS_ACTIVE)))
      .returning({ id: this.tables.jobsTable.id })

    // Also delete associated steps
    if (result.length > 0) {
      await this.db.delete(this.tables.jobStepsTable).where(eq(this.tables.jobStepsTable.job_id, jobId))
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
    const jobsTable = this.tables.jobsTable
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
        FROM ${this.tables.jobsTable} j
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
        LEFT JOIN ${this.tables.jobsTable} j
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
        FROM ${this.tables.jobsTable} j
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
          FROM ${this.tables.jobsTable}
          WHERE action_name = nj.action_name
            AND group_key = nj.job_group_key
            AND status = ${JOB_STATUS_ACTIVE}) as current_active
        FROM next_job nj
        INNER JOIN eligible_groups eg
          ON nj.job_group_key = eg.group_key
          AND nj.action_name = eg.action_name
      )
      UPDATE ${this.tables.jobsTable} j
      SET status = ${JOB_STATUS_ACTIVE},
          started_at = now(),
          expires_at = now() + (timeout_ms || ' milliseconds')::interval,
          client_id = ${this.id}
      FROM verify_concurrency vc
      WHERE j.id = vc.id
        AND vc.current_active < vc.concurrency_limit  -- Final concurrency check using job's concurrency limit
      RETURNING
        j.id,
        j.action_name as "actionName",
        j.group_key as "groupKey",
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
        j.concurrency_limit as "concurrencyLimit"
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
          clientId: this.tables.jobsTable.client_id,
        })
        .from(this.tables.jobsTable)
        .where(
          and(eq(this.tables.jobsTable.status, JOB_STATUS_ACTIVE), ne(this.tables.jobsTable.client_id, this.id)),
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
          FROM ${this.tables.jobsTable} j
          WHERE j.status = ${JOB_STATUS_ACTIVE}
            AND j.client_id IN ${unresponsiveClientIds}
          FOR UPDATE OF j SKIP LOCKED
        ),
        updated_jobs AS (
          UPDATE ${this.tables.jobsTable} j
          SET status = ${JOB_STATUS_CREATED},
              started_at = NULL,
              expires_at = NULL,
              finished_at = NULL,
              output = NULL,
              error = NULL
          WHERE EXISTS (SELECT 1 FROM locked_jobs lj WHERE lj.id = j.id)
          RETURNING id, checksum
        ),
        deleted_steps AS (
          DELETE FROM ${this.tables.jobStepsTable} s
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
  }: CreateOrRecoverJobStepOptions): Promise<CreateOrRecoverJobStepResult | null> {
    type StepResult = CreateOrRecoverJobStepResult

    const [result] = this._map(
      await this.db.execute<StepResult>(sql`
      WITH job_check AS (
        SELECT j.id
        FROM ${this.tables.jobsTable} j
        WHERE j.id = ${jobId}
          AND j.status = ${JOB_STATUS_ACTIVE}
          AND (j.expires_at IS NULL OR j.expires_at > now())
      ),
      step_existed AS (
        SELECT EXISTS(
          SELECT 1 FROM ${this.tables.jobStepsTable} s
          WHERE s.job_id = ${jobId} AND s.name = ${name}
        ) AS existed
      ),
      upserted_step AS (
        INSERT INTO ${this.tables.jobStepsTable} (
          job_id,
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
          ${name},
          ${timeoutMs},
          ${retriesLimit},
          ${STEP_STATUS_ACTIVE},
          now(),
          now() + interval '${sql.raw(timeoutMs.toString())} milliseconds',
          0,
          NULL
        WHERE EXISTS (SELECT 1 FROM job_check)
        ON CONFLICT (job_id, name) DO UPDATE
        SET
          timeout_ms = ${timeoutMs},
          expires_at = now() + interval '${sql.raw(timeoutMs.toString())} milliseconds',
          retries_count = 0,
          retries_limit = ${retriesLimit},
          delayed_ms = NULL,
          started_at = now(),
          history_failed_attempts = '{}'::jsonb
        WHERE ${this.tables.jobStepsTable}.status = ${STEP_STATUS_ACTIVE}
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
        FROM ${this.tables.jobStepsTable} s
        INNER JOIN job_check jc ON s.job_id = jc.id
        WHERE s.job_id = ${jobId}
          AND s.name = ${name}
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
      .update(this.tables.jobStepsTable)
      .set({
        status: STEP_STATUS_COMPLETED,
        output,
        finished_at: sql`now()`,
      })
      .from(this.tables.jobsTable)
      .where(
        and(
          eq(this.tables.jobStepsTable.job_id, this.tables.jobsTable.id),
          eq(this.tables.jobStepsTable.id, stepId),
          eq(this.tables.jobStepsTable.status, STEP_STATUS_ACTIVE),
          eq(this.tables.jobsTable.status, JOB_STATUS_ACTIVE),
          or(isNull(this.tables.jobsTable.expires_at), gt(this.tables.jobsTable.expires_at, sql`now()`)),
        ),
      )
      .returning({ id: this.tables.jobStepsTable.id })

    return result.length > 0
  }

  /**
   * Internal method to mark a job step as failed.
   *
   * @returns Promise resolving to `true` if failed, `false` otherwise
   */
  protected async _failJobStep({ stepId, error }: FailJobStepOptions) {
    const result = await this.db
      .update(this.tables.jobStepsTable)
      .set({
        status: STEP_STATUS_FAILED,
        error,
        finished_at: sql`now()`,
      })
      .from(this.tables.jobsTable)
      .where(
        and(
          eq(this.tables.jobStepsTable.job_id, this.tables.jobsTable.id),
          eq(this.tables.jobStepsTable.id, stepId),
          eq(this.tables.jobStepsTable.status, STEP_STATUS_ACTIVE),
          eq(this.tables.jobsTable.status, JOB_STATUS_ACTIVE),
        ),
      )
      .returning({ id: this.tables.jobStepsTable.id })

    return result.length > 0
  }

  /**
   * Internal method to delay a job step.
   *
   * @returns Promise resolving to `true` if delayed, `false` otherwise
   */
  protected async _delayJobStep({ stepId, delayMs, error }: DelayJobStepOptions) {
    const jobStepsTable = this.tables.jobStepsTable
    const jobsTable = this.tables.jobsTable

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
      .update(this.tables.jobStepsTable)
      .set({
        status: STEP_STATUS_CANCELLED,
        finished_at: sql`now()`,
      })
      .from(this.tables.jobsTable)
      .where(
        and(
          eq(this.tables.jobStepsTable.job_id, this.tables.jobsTable.id),
          eq(this.tables.jobStepsTable.id, stepId),
          eq(this.tables.jobStepsTable.status, STEP_STATUS_ACTIVE),
          or(
            eq(this.tables.jobsTable.status, JOB_STATUS_ACTIVE),
            eq(this.tables.jobsTable.status, JOB_STATUS_CANCELLED),
          ),
        ),
      )
      .returning({ id: this.tables.jobStepsTable.id })

    return result.length > 0
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Internal method to get a job by its ID. Does not include step information.
   */
  protected async _getJobById(jobId: string): Promise<Job | null> {
    const [job] = await this.db
      .select({
        id: this.tables.jobsTable.id,
        actionName: this.tables.jobsTable.action_name,
        groupKey: this.tables.jobsTable.group_key,
        input: this.tables.jobsTable.input,
        output: this.tables.jobsTable.output,
        error: this.tables.jobsTable.error,
        status: this.tables.jobsTable.status,
        timeoutMs: this.tables.jobsTable.timeout_ms,
        expiresAt: this.tables.jobsTable.expires_at,
        startedAt: this.tables.jobsTable.started_at,
        finishedAt: this.tables.jobsTable.finished_at,
        createdAt: this.tables.jobsTable.created_at,
        updatedAt: this.tables.jobsTable.updated_at,
        concurrencyLimit: this.tables.jobsTable.concurrency_limit,
        clientId: this.tables.jobsTable.client_id,
      })
      .from(this.tables.jobsTable)
      .where(eq(this.tables.jobsTable.id, jobId))
      .limit(1)

    return job ?? null
  }

  /**
   * Internal method to get steps for a job with pagination and fuzzy search.
   * Steps are always ordered by created_at ASC.
   * Steps do not include output data.
   */
  protected async _getJobSteps(options: GetJobStepsOptions): Promise<GetJobStepsResult> {
    const { jobId, page = 1, pageSize = 10, search } = options

    const jobStepsTable = this.tables.jobStepsTable

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

    // Get total count
    const total = await this.db.$count(jobStepsTable, where)

    if (!total) {
      return {
        steps: [],
        total: 0,
        page,
        pageSize,
      }
    }

    const steps = await this.db
      .select({
        id: jobStepsTable.id,
        jobId: jobStepsTable.job_id,
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
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    return {
      steps,
      total,
      page,
      pageSize,
    }
  }

  protected _buildJobsWhereClause(filters: GetJobsOptions['filters']) {
    if (!filters) {
      return undefined
    }

    const jobsTable = this.tables.jobsTable

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
   * Internal method to get jobs with pagination, filtering, and sorting.
   * Does not include step information or job output.
   */
  protected async _getJobs(options?: GetJobsOptions): Promise<GetJobsResult> {
    const jobsTable = this.tables.jobsTable
    const page = options?.page ?? 1
    const pageSize = options?.pageSize ?? 10
    const filters = options?.filters ?? {}

    const sortInput = options?.sort ?? { field: 'startedAt', order: 'desc' }
    const sorts = Array.isArray(sortInput) ? sortInput : [sortInput]

    const where = this._buildJobsWhereClause(filters)

    // Get total count
    const total = await this.db.$count(jobsTable, where)
    if (!total) {
      return {
        jobs: [],
        total: 0,
        page,
        pageSize,
      }
    }

    const sortFieldMap: Record<JobSort['field'], any> = {
      createdAt: jobsTable.created_at,
      startedAt: jobsTable.started_at,
      finishedAt: jobsTable.finished_at,
      status: jobsTable.status,
      actionName: jobsTable.action_name,
      expiresAt: jobsTable.expires_at,
    }

    const jobs = await this.db
      .select({
        id: jobsTable.id,
        actionName: jobsTable.action_name,
        groupKey: jobsTable.group_key,
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
        clientId: jobsTable.client_id,
      })
      .from(jobsTable)
      .where(where)
      .orderBy(
        ...sorts
          .filter((sortItem) => sortItem.field in sortFieldMap)
          .map((sortItem) => {
            const sortField = sortFieldMap[sortItem.field]
            if (sortItem.order.toUpperCase() === 'ASC') {
              return asc(sortField)
            } else {
              return desc(sortField)
            }
          }),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    return {
      jobs,
      total,
      page,
      pageSize,
    }
  }

  /**
   * Internal method to get a step by its ID with all information.
   */
  protected async _getJobStepById(stepId: string): Promise<JobStep | null> {
    const [step] = await this.db
      .select({
        id: this.tables.jobStepsTable.id,
        jobId: this.tables.jobStepsTable.job_id,
        name: this.tables.jobStepsTable.name,
        output: this.tables.jobStepsTable.output,
        status: this.tables.jobStepsTable.status,
        error: this.tables.jobStepsTable.error,
        startedAt: this.tables.jobStepsTable.started_at,
        finishedAt: this.tables.jobStepsTable.finished_at,
        timeoutMs: this.tables.jobStepsTable.timeout_ms,
        expiresAt: this.tables.jobStepsTable.expires_at,
        retriesLimit: this.tables.jobStepsTable.retries_limit,
        retriesCount: this.tables.jobStepsTable.retries_count,
        delayedMs: this.tables.jobStepsTable.delayed_ms,
        historyFailedAttempts: this.tables.jobStepsTable.history_failed_attempts,
        createdAt: this.tables.jobStepsTable.created_at,
        updatedAt: this.tables.jobStepsTable.updated_at,
      })
      .from(this.tables.jobStepsTable)
      .where(eq(this.tables.jobStepsTable.id, stepId))
      .limit(1)

    return step ?? null
  }

  /**
   * Internal method to get job status and updatedAt timestamp.
   */
  protected async _getJobStatus(jobId: string): Promise<JobStatusResult | null> {
    const [job] = await this.db
      .select({
        status: this.tables.jobsTable.status,
        updatedAt: this.tables.jobsTable.updated_at,
      })
      .from(this.tables.jobsTable)
      .where(eq(this.tables.jobsTable.id, jobId))
      .limit(1)

    return job ?? null
  }

  /**
   * Internal method to get job step status and updatedAt timestamp.
   */
  protected async _getJobStepStatus(stepId: string): Promise<JobStepStatusResult | null> {
    const [step] = await this.db
      .select({
        status: this.tables.jobStepsTable.status,
        updatedAt: this.tables.jobStepsTable.updated_at,
      })
      .from(this.tables.jobStepsTable)
      .where(eq(this.tables.jobStepsTable.id, stepId))
      .limit(1)

    return step ?? null
  }

  /**
   * Internal method to get action statistics including counts and last job created date.
   */
  protected async _getActions(): Promise<GetActionsResult> {
    const actionStats = this.db.$with('action_stats').as(
      this.db
        .select({
          name: this.tables.jobsTable.action_name,
          last_job_created: sql<Date | null>`MAX(${this.tables.jobsTable.created_at})`.as('last_job_created'),
          active: sql<number>`COUNT(*) FILTER (WHERE ${this.tables.jobsTable.status} = ${JOB_STATUS_ACTIVE})`.as(
            'active',
          ),
          completed: sql<number>`COUNT(*) FILTER (WHERE ${this.tables.jobsTable.status} = ${JOB_STATUS_COMPLETED})`.as(
            'completed',
          ),
          failed: sql<number>`COUNT(*) FILTER (WHERE ${this.tables.jobsTable.status} = ${JOB_STATUS_FAILED})`.as(
            'failed',
          ),
          cancelled: sql<number>`COUNT(*) FILTER (WHERE ${this.tables.jobsTable.status} = ${JOB_STATUS_CANCELLED})`.as(
            'cancelled',
          ),
        })
        .from(this.tables.jobsTable)
        .groupBy(this.tables.jobsTable.action_name),
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
}
