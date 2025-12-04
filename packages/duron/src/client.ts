import pino, { type Logger } from 'pino'
import { zocker } from 'zocker'
import * as z from 'zod'

import type { Action, ConcurrencyHandlerContext } from './action.js'
import { ActionManager } from './action-manager.js'
import type {
  Adapter,
  GetActionsResult,
  GetJobStepsOptions,
  GetJobStepsResult,
  GetJobsOptions,
  GetJobsResult,
  Job,
  JobStep,
} from './adapters/adapter.js'
import type { JobStatusResult, JobStepStatusResult } from './adapters/schemas.js'
import { JOB_STATUS_CANCELLED, JOB_STATUS_COMPLETED, JOB_STATUS_FAILED, type JobStatus } from './constants.js'

const BaseOptionsSchema = z.object({
  /**
   * Unique identifier for this Duron instance.
   * Used for multi-process coordination and job ownership.
   * Defaults to a random UUID if not provided.
   */
  id: z.string().optional(),

  /**
   * Synchronization pattern for fetching jobs.
   * - `'pull'`: Periodically poll the database for new jobs
   * - `'push'`: Listen for database notifications when jobs are available
   * - `'hybrid'`: Use both pull and push patterns (recommended)
   * - `false`: Disable automatic job fetching (manual fetching only)
   *
   * @default 'hybrid'
   */
  syncPattern: z.union([z.literal('pull'), z.literal('push'), z.literal('hybrid'), z.literal(false)]).default('hybrid'),

  /**
   * Interval in milliseconds between pull operations when using pull or hybrid sync pattern.
   *
   * @default 5000
   */
  pullInterval: z.number().default(5_000),

  /**
   * Maximum number of jobs to fetch in a single batch.
   *
   * @default 10
   */
  batchSize: z.number().default(10),

  /**
   * Maximum number of jobs that can run concurrently per action.
   * This controls the concurrency limit for the action's fastq queue.
   *
   * @default 100
   */
  actionConcurrencyLimit: z.number().default(100),

  /**
   * Maximum number of jobs that can run concurrently per group key.
   * Jobs with the same group key will respect this limit.
   * This can be overridden using action -> groups -> concurrency.
   *
   * @default 10
   */
  groupConcurrencyLimit: z.number().default(10),

  /**
   * Whether to run database migrations on startup.
   * When enabled, Duron will automatically apply pending migrations when the adapter starts.
   *
   * @default true
   */
  migrateOnStart: z.boolean().default(true),

  /**
   * Whether to recover stuck jobs on startup.
   * Stuck jobs are jobs that were marked as active but the process that owned them
   * is no longer running.
   *
   * @default true
   */
  recoverJobsOnStart: z.boolean().default(true),

  /**
   * Enable multi-process mode for job recovery.
   * When enabled, Duron will ping other processes to check if they're alive
   * before recovering their jobs.
   *
   * @default false
   */
  multiProcessMode: z.boolean().default(false),

  /**
   * Timeout in milliseconds to wait for process ping responses in multi-process mode.
   * Processes that don't respond within this timeout will have their jobs recovered.
   *
   * @default 5000 (5 seconds)
   */
  processTimeout: z.number().default(5 * 1000), // 5 seconds
})

/**
 * Options for configuring a Duron instance.
 *
 * @template TActions - Record of action definitions keyed by action name
 * @template TVariables - Type of variables available to actions
 */
export interface ClientOptions<
  TActions extends Record<string, Action<any, any, TVariables>>,
  TVariables = Record<string, unknown>,
> extends z.input<typeof BaseOptionsSchema> {
  /**
   * The database adapter to use for storing jobs and steps.
   * Required.
   */
  database: Adapter

  /**
   * A record of action definitions, where each key is the action name.
   * Required.
   */
  actions?: TActions

  /**
   * Logger instance or log level for logging events and errors.
   * Can be a pino Logger instance or a log level string ('fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent').
   * If not provided, defaults to 'error' level.
   */
  logger?: Logger | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'

  /**
   * Variables available to all actions via the context.
   * These can be accessed in action handlers using `ctx.var`.
   */
  variables?: TVariables
}

interface FetchOptions {
  batchSize?: number
}

/**
 * Client is the main entry point for Duron.
 * Manages job execution, action handling, and database operations.
 *
 * @template TActions - Record of action definitions keyed by action name
 * @template TVariables - Type of variables available to actions
 */
export class Client<
  TActions extends Record<string, Action<any, any, TVariables>>,
  TVariables = Record<string, unknown>,
> {
  #options: z.infer<typeof BaseOptionsSchema>
  #id: string
  #actions: TActions | null
  #database: Adapter
  #variables: Record<string, unknown>
  #logger: Logger
  #started: boolean = false
  #stopped: boolean = false
  #starting: Promise<boolean> | null = null
  #stopping: Promise<boolean> | null = null
  #pullInterval: NodeJS.Timeout | null = null
  #actionManagers = new Map<string, ActionManager<Action<any, any, any>>>()
  #mockInputSchemas = new Map<string, any>()
  #pendingJobWaits = new Map<
    string,
    Set<{
      resolve: (job: Job | null) => void
      timeoutId?: NodeJS.Timeout
      signal?: AbortSignal
      abortHandler?: () => void
    }>
  >()
  #jobStatusListenerSetup = false

  // ============================================================================
  // Constructor
  // ============================================================================

  /**
   * Create a new Duron Client instance.
   *
   * @param options - Configuration options for the client
   */
  constructor(options: ClientOptions<TActions, TVariables>) {
    this.#options = BaseOptionsSchema.parse(options)
    this.#id = options.id ?? globalThis.crypto.randomUUID()
    this.#database = options.database
    this.#actions = options.actions ?? null
    this.#variables = options?.variables ?? {}
    this.#logger = this.#normalizeLogger(options?.logger)
    this.#database.setId(this.#id)
    this.#database.setLogger(this.#logger)
  }

  #normalizeLogger(logger?: Logger | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'): Logger {
    let pinoInstance: Logger | null = null
    if (!logger) {
      pinoInstance = pino({ level: 'error' })
    } else if (typeof logger === 'string') {
      pinoInstance = pino({ level: logger })
    } else {
      pinoInstance = logger
    }
    return pinoInstance.child({ duron: this.#id })
  }

  // ============================================================================
  // Public API Methods
  // ============================================================================

  get logger() {
    return this.#logger
  }

  /**
   * Get the current configuration of this Duron instance.
   *
   * @returns Configuration object including options, actions, and variables
   */
  getConfig() {
    return {
      ...this.#options,
      actions: this.#actions,
      variables: this.#variables,
    }
  }

  /**
   * Run an action by creating a new job.
   *
   * @param actionName - Name of the action to run
   * @param input - Input data for the action (validated against action's input schema if provided)
   * @returns Promise resolving to the created job ID
   * @throws Error if action is not found or job creation fails
   */
  async runAction<TActionName extends keyof TActions>(
    actionName: TActionName,
    input?: NonNullable<TActions[TActionName]['input']> extends z.ZodObject
      ? z.input<NonNullable<TActions[TActionName]['input']>>
      : never,
  ): Promise<string> {
    await this.start()

    const action = this.#actions?.[actionName]
    if (!action) {
      throw new Error(`Action ${String(actionName)} not found`)
    }

    // Validate input if schema is provided
    let validatedInput: any = input ?? {}
    if (action.input) {
      validatedInput = action.input.parse(validatedInput, {
        error: () => 'Error parsing action input',
        reportInput: true,
      })
    }

    // Determine groupKey and concurrency limit using concurrency handler or defaults
    const concurrencyCtx: ConcurrencyHandlerContext<typeof action.input, TVariables> = {
      input: validatedInput,
      var: this.#variables as TVariables,
    }

    let groupKey = '@default'
    if (action.groups?.groupKey) {
      groupKey = await action.groups.groupKey(concurrencyCtx)
    }

    let concurrencyLimit = this.#options.groupConcurrencyLimit
    if (action.groups?.concurrency) {
      concurrencyLimit = await action.groups.concurrency(concurrencyCtx)
    }

    // Create job in database
    const jobId = await this.#database.createJob({
      queue: action.name,
      groupKey,
      input: validatedInput,
      timeoutMs: action.expire,
      checksum: action.checksum,
      concurrencyLimit,
    })

    if (!jobId) {
      throw new Error(`Failed to create job for action ${String(actionName)}`)
    }

    this.#logger.debug({ jobId, actionName: String(actionName), groupKey }, '[Duron] Action sent/created')

    return jobId
  }

  /**
   * Fetch and process jobs from the database.
   * Concurrency limits are determined from the latest job created for each groupKey.
   *
   * @param options - Fetch options including batch size
   * @returns Promise resolving to the array of fetched jobs
   */
  async fetch(options: FetchOptions) {
    await this.start()

    if (!this.#actions) {
      return []
    }

    // Fetch jobs from each action's queue
    // Concurrency limits are determined from the latest job created for each groupKey
    const jobs = await this.#database.fetch({
      batch: options.batchSize ?? this.#options.batchSize,
    })

    // Process fetched jobs
    for (const job of jobs) {
      this.#executeJob(job)
    }

    return jobs
  }

  /**
   * Cancel a job by its ID.
   * If the job is currently being processed, it will be cancelled immediately.
   * Otherwise, it will be cancelled in the database.
   *
   * @param jobId - The ID of the job to cancel
   * @returns Promise resolving to `true` if cancelled, `false` otherwise
   */
  async cancelJob(jobId: string) {
    await this.start()

    let cancelled = false
    for (const manager of this.#actionManagers.values()) {
      cancelled = manager.cancelJob(jobId)
      if (cancelled) {
        break
      }
    }

    if (!cancelled) {
      // If the job is not being processed, cancel it in the database
      await this.#database.cancelJob({ jobId })
    }

    return cancelled
  }

  /**
   * Retry a failed job by creating a copy of it with status 'created' and cleared output/error.
   *
   * @param jobId - The ID of the job to retry
   * @returns Promise resolving to the new job ID, or `null` if retry failed
   */
  async retryJob(jobId: string): Promise<string | null> {
    await this.start()
    return this.#database.retryJob({ jobId })
  }

  /**
   * Delete a job by its ID.
   * Active jobs cannot be deleted.
   *
   * @param jobId - The ID of the job to delete
   * @returns Promise resolving to `true` if deleted, `false` otherwise
   */
  async deleteJob(jobId: string): Promise<boolean> {
    await this.start()
    return this.#database.deleteJob({ jobId })
  }

  /**
   * Delete multiple jobs using the same filters as getJobs.
   * Active jobs cannot be deleted and will be excluded from deletion.
   *
   * @param options - Query options including filters (same as getJobs)
   * @returns Promise resolving to the number of jobs deleted
   */
  async deleteJobs(options?: GetJobsOptions): Promise<number> {
    await this.start()
    return this.#database.deleteJobs(options)
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Get a job by its ID. Does not include step information.
   *
   * @param jobId - The ID of the job to retrieve
   * @returns Promise resolving to the job, or `null` if not found
   */
  async getJobById(jobId: string): Promise<Job | null> {
    await this.start()
    return this.#database.getJobById(jobId)
  }

  /**
   * Get steps for a job with pagination and fuzzy search.
   * Steps are always ordered by created_at ASC.
   * Steps do not include output data.
   *
   * @param options - Query options including jobId, pagination, and search
   * @returns Promise resolving to steps result with pagination info
   */
  async getJobSteps(options: GetJobStepsOptions): Promise<GetJobStepsResult> {
    await this.start()
    return this.#database.getJobSteps(options)
  }

  /**
   * Get jobs with pagination, filtering, and sorting.
   * Does not include step information or job output.
   *
   * @param options - Query options including pagination, filters, and sort
   * @returns Promise resolving to jobs result with pagination info
   */
  async getJobs(options?: GetJobsOptions): Promise<GetJobsResult> {
    await this.start()
    return this.#database.getJobs(options)
  }

  /**
   * Get a step by its ID with all information.
   *
   * @param stepId - The ID of the step to retrieve
   * @returns Promise resolving to the step, or `null` if not found
   */
  async getJobStepById(stepId: string): Promise<JobStep | null> {
    await this.start()
    return this.#database.getJobStepById(stepId)
  }

  /**
   * Get job status and updatedAt timestamp.
   *
   * @param jobId - The ID of the job
   * @returns Promise resolving to job status result, or `null` if not found
   */
  async getJobStatus(jobId: string): Promise<JobStatusResult | null> {
    await this.start()
    return this.#database.getJobStatus(jobId)
  }

  /**
   * Get job step status and updatedAt timestamp.
   *
   * @param stepId - The ID of the step
   * @returns Promise resolving to step status result, or `null` if not found
   */
  async getJobStepStatus(stepId: string): Promise<JobStepStatusResult | null> {
    await this.start()
    return this.#database.getJobStepStatus(stepId)
  }

  /**
   * Wait for a job to change status by subscribing to job-status-changed events.
   * When the job status changes, the job is fetched and returned.
   *
   * @param jobId - The ID of the job to wait for
   * @param options - Optional configuration including timeout
   * @returns Promise resolving to the job when its status changes, or `null` if timeout
   */
  async waitForJob(
    jobId: string,
    options?: {
      /**
       * Timeout in milliseconds. If the job status doesn't change within this time, the promise resolves to `null`.
       * Defaults to no timeout (waits indefinitely).
       */
      timeout?: number
      /**
       * AbortSignal to cancel waiting. If aborted, the promise resolves to `null`.
       */
      signal?: AbortSignal
    },
  ): Promise<Job | null> {
    await this.start()

    // First, check if the job already exists and is in a terminal state
    const existingJobStatus = await this.getJobStatus(jobId)
    if (existingJobStatus) {
      const terminalStatuses: JobStatus[] = [JOB_STATUS_COMPLETED, JOB_STATUS_FAILED, JOB_STATUS_CANCELLED]
      if (terminalStatuses.includes(existingJobStatus.status)) {
        const job = await this.getJobById(jobId)
        if (!job) {
          return null
        }
        return job
      }
    }

    // Set up the shared event listener if not already set up
    this.#setupJobStatusListener()

    return new Promise<Job | null>((resolve) => {
      // Check if already aborted before setting up wait
      if (options?.signal?.aborted) {
        resolve(null)
        return
      }

      let timeoutId: NodeJS.Timeout | undefined
      let abortHandler: (() => void) | undefined

      // Set up timeout if provided
      if (options?.timeout) {
        timeoutId = setTimeout(() => {
          this.#removeJobWait(jobId, resolve)
          resolve(null)
        }, options.timeout)
      }

      // Set up abort signal if provided
      if (options?.signal) {
        abortHandler = () => {
          this.#removeJobWait(jobId, resolve)
          resolve(null)
        }
        options.signal.addEventListener('abort', abortHandler)
      }

      // Add this wait request to the pending waits
      if (!this.#pendingJobWaits.has(jobId)) {
        this.#pendingJobWaits.set(jobId, new Set())
      }
      this.#pendingJobWaits.get(jobId)!.add({
        resolve,
        timeoutId,
        signal: options?.signal,
        abortHandler,
      })
    })
  }

  /**
   * Get action statistics including counts and last job created date.
   *
   * @returns Promise resolving to action statistics
   */
  async getActions(): Promise<GetActionsResult> {
    await this.start()
    return this.#database.getActions()
  }

  /**
   * Get action metadata including input schemas and mock data.
   * This is useful for generating UI forms or mock data.
   *
   * @returns Promise resolving to action metadata
   */
  async getActionsMetadata(): Promise<Array<{ name: string; mockInput: any }>> {
    await this.start()

    if (!this.#actions) {
      return []
    }

    return Object.values(this.#actions).map((action) => {
      let mockInput = {}
      if (action.input) {
        if (!this.#mockInputSchemas.has(action.name)) {
          this.#mockInputSchemas.set(
            action.name,
            zocker(action.input as z.ZodObject)
              .override(z.ZodString, 'string')
              .generate(),
          )
        }
        mockInput = this.#mockInputSchemas.get(action.name)
      }
      return {
        name: action.name,
        mockInput,
      }
    })
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Start the Duron instance.
   * Initializes the database, recovers stuck jobs, and sets up sync patterns.
   *
   * @returns Promise resolving to `true` if started successfully, `false` otherwise
   */
  async start() {
    if (this.#stopping || this.#stopped) {
      return false
    }

    if (this.#started) {
      return true
    }

    if (this.#starting) {
      return this.#starting
    }

    this.#starting = (async () => {
      const dbStarted = await this.#database.start()
      if (!dbStarted) {
        return false
      }

      if (this.#actions) {
        if (this.#options.recoverJobsOnStart) {
          await this.#database.recoverJobs({
            checksums: Object.values(this.#actions).map((action) => action.checksum),
            multiProcessMode: this.#options.multiProcessMode,
            processTimeout: this.#options.processTimeout,
          })
        }

        // Setup sync pattern
        if (this.#options.syncPattern === 'pull' || this.#options.syncPattern === 'hybrid') {
          this.#startPullLoop()
        }

        if (this.#options.syncPattern === 'push' || this.#options.syncPattern === 'hybrid') {
          this.#setupPushListener()
        }
      }

      this.#started = true
      this.#starting = null
      return true
    })()

    return this.#starting
  }

  /**
   * Stop the Duron instance.
   * Stops the pull loop, aborts all running jobs, waits for queues to drain, and stops the database.
   *
   * @returns Promise resolving to `true` if stopped successfully, `false` otherwise
   */
  async stop() {
    if (this.#stopped) {
      return true
    }

    if (this.#stopping) {
      return this.#stopping
    }

    this.#stopping = (async () => {
      // Stop pull loop
      if (this.#pullInterval) {
        clearTimeout(this.#pullInterval)
        this.#pullInterval = null
      }

      // Clean up all pending job waits
      for (const waits of this.#pendingJobWaits.values()) {
        for (const wait of waits) {
          if (wait.timeoutId) {
            clearTimeout(wait.timeoutId)
          }
          if (wait.signal && wait.abortHandler) {
            wait.signal.removeEventListener('abort', wait.abortHandler)
          }
          wait.resolve(null)
        }
      }
      this.#pendingJobWaits.clear()

      // Wait for action managers to drain
      await Promise.all(
        Array.from(this.#actionManagers.values()).map(async (manager) => {
          await manager.stop()
        }),
      )

      const dbStopped = await this.#database.stop()
      if (!dbStopped) {
        return false
      }

      this.#stopped = true
      this.#stopping = null
      return true
    })()

    return this.#stopping
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Set up the shared event listener for job-status-changed events.
   * This listener is shared across all waitForJob calls to avoid multiple listeners.
   */
  #setupJobStatusListener() {
    if (this.#jobStatusListenerSetup) {
      return
    }

    this.#jobStatusListenerSetup = true

    this.#database.on(
      'job-status-changed',
      async (event: { jobId: string; status: JobStatus | 'retried'; clientId: string }) => {
        const pendingWaits = this.#pendingJobWaits.get(event.jobId)
        if (!pendingWaits || pendingWaits.size === 0) {
          return
        }

        // Fetch the job once for all pending waits
        const job = await this.getJobById(event.jobId)

        // Resolve all pending waits for this job
        const waitsToResolve = Array.from(pendingWaits)
        this.#pendingJobWaits.delete(event.jobId)

        for (const wait of waitsToResolve) {
          // Clean up timeout and abort signal
          if (wait.timeoutId) {
            clearTimeout(wait.timeoutId)
          }
          if (wait.signal && wait.abortHandler) {
            wait.signal.removeEventListener('abort', wait.abortHandler)
          }
          wait.resolve(job)
        }
      },
    )
  }

  /**
   * Remove a specific wait request from the pending waits.
   *
   * @param jobId - The job ID
   * @param resolve - The resolve function to remove
   */
  #removeJobWait(jobId: string, resolve: (job: Job | null) => void) {
    const pendingWaits = this.#pendingJobWaits.get(jobId)
    if (!pendingWaits) {
      return
    }

    // Find and remove the specific wait request
    for (const wait of pendingWaits) {
      if (wait.resolve === resolve) {
        if (wait.timeoutId) {
          clearTimeout(wait.timeoutId)
        }
        if (wait.signal && wait.abortHandler) {
          wait.signal.removeEventListener('abort', wait.abortHandler)
        }
        pendingWaits.delete(wait)
        break
      }
    }

    // Clean up empty sets
    if (pendingWaits.size === 0) {
      this.#pendingJobWaits.delete(jobId)
    }
  }

  /**
   * Execute a job by finding its action and queuing it with the appropriate ActionManager.
   *
   * @param job - The job to execute
   */
  #executeJob(job: Job) {
    if (!this.#actions) {
      return
    }

    const action = Object.values(this.#actions).find((a) => a.name === job.actionName)
    if (!action) {
      const error = { name: 'ActionNotFoundError', message: `Action "${job.actionName}" not found for job ${job.id}` }
      this.#logger.warn({ jobId: job.id, actionName: job.actionName }, `[Duron] Action not found for job ${job.id}`)
      this.#database.failJob({ jobId: job.id, error }).catch((dbError) => {
        this.#logger.error({ error: dbError, jobId: job.id }, `[Duron] Error failing job ${job.id}`)
      })
      return
    }

    // Get or create ActionManager for this action
    let actionManager = this.#actionManagers.get(action.name)
    if (!actionManager) {
      actionManager = new ActionManager({
        action,
        database: this.#database,
        variables: this.#variables,
        logger: this.#logger,
        concurrencyLimit: this.#options.actionConcurrencyLimit,
      })
      this.#actionManagers.set(action.name, actionManager)
    }

    // Queue job execution
    actionManager.push(job).catch((err) => {
      // Only log unexpected errors (not cancellation/timeout which are handled elsewhere)
      this.#logger.error(
        { err, jobId: job.id, actionName: action.name },
        `[Duron] Error executing job ${job.id} for action ${action.name}`,
      )
    })
  }

  /**
   * Start the pull loop for periodically fetching jobs.
   * Only starts if not already running.
   */
  #startPullLoop() {
    if (this.#pullInterval) {
      return
    }

    const pull = async () => {
      if (this.#stopped) {
        return
      }

      try {
        await this.fetch({
          batchSize: this.#options.batchSize,
        })
      } catch (error) {
        this.#logger.error({ error }, '[Duron] [PullLoop] Error in pull loop')
      }

      if (!this.#stopped) {
        this.#pullInterval = setTimeout(pull, this.#options.pullInterval)
      }
    }

    // Start immediately
    pull()
  }

  /**
   * Setup the push listener for database notifications.
   * Listens for 'job-available' events and fetches jobs when notified.
   */
  #setupPushListener() {
    this.#database.on('job-available', async () => {
      this.fetch({
        batchSize: 1,
      }).catch((error) => {
        this.#logger.error({ error }, '[Duron] [PushListener] Error fetching job')
      })
    })
  }
}
