import { type Span, type Tracer, trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import pino, { type Logger } from 'pino'
import { zocker } from 'zocker'
import * as z from 'zod'

import { ActionManager } from './action-manager.js'
import type { Action, ConcurrencyHandlerContext } from './action.js'
import type {
  Adapter,
  ArchiveStats,
  GetActionsResult,
  GetJobStepsOptions,
  GetJobStepsResult,
  GetJobsOptions,
  GetJobsResult,
  GetSpansOptions,
  GetSpansResult,
  Job,
  JobStep,
  PruneArchiveOptions,
} from './adapters/adapter.js'
import type { JobStatusResult, JobStepStatusResult } from './adapters/schemas.js'
import {
  JOB_STATUS_CANCELLED,
  JOB_STATUS_COMPLETED,
  JOB_STATUS_FAILED,
  type JobStatus,
} from './constants.js'
import { LocalSpanExporter } from './telemetry/local-span-exporter.js'

/**
 * Extracts the inferred type from an action's input/output schema.
 * Handles the case where the schema might be undefined.
 */
type InferActionSchema<T> = T extends z.ZodTypeAny ? z.infer<T> : Record<string, unknown>

/**
 * Result returned from waitForJob with untyped input and output.
 */
export interface JobResult {
  id: string
  actionName: string
  status: JobStatus
  groupKey: string
  description: string | null
  input: unknown
  output: unknown
  error: Job['error']
}

/**
 * Result returned from runActionAndWait with typed input and output based on the action's Zod schemas.
 */
export interface TypedJobResult<TAction extends Action<any, any, any>> {
  id: string
  actionName: string
  status: JobStatus
  groupKey: string
  description: string | null
  input: InferActionSchema<NonNullable<TAction['input']>>
  output: InferActionSchema<NonNullable<TAction['output']>>
  error: Job['error']
}

/**
 * Telemetry context provided to action and step handlers.
 * Provides access to OpenTelemetry APIs for recording traces and metrics.
 */
export interface TelemetryContext {
  /**
   * Get the active OpenTelemetry span for the current job/step.
   * Use standard OTel Span methods: setAttribute, addEvent, recordException, etc.
   */
  getActiveSpan(): Span

  /**
   * Get an OpenTelemetry tracer for creating custom spans.
   *
   * @param name - The name of the tracer (typically your service or library name)
   */
  getTracer(name: string): Tracer

  /**
   * Record a custom metric as a span event.
   * This is a convenience method that stores metrics as span events
   * which can be queried from the local database when telemetry.local is enabled.
   *
   * @param name - The metric name (e.g., 'tokens.input', 'latency.ms')
   * @param value - The metric value
   * @param attributes - Optional attributes for the metric
   */
  recordMetric(name: string, value: number, attributes?: Record<string, any>): void
}

/**
 * Options for local telemetry storage.
 */
export interface LocalTelemetryOptions {
  /**
   * Delay in milliseconds before flushing spans to the database.
   * Uses BatchSpanProcessor with this delay.
   * @default 5000
   */
  flushDelayMs?: number
}

/**
 * Telemetry configuration options.
 * Uses OpenTelemetry SDK for tracing.
 */
export interface TelemetryOptions {
  /**
   * Enable local span storage in the database.
   * When enabled, spans are stored in the database and can be queried via getSpans().
   * Set to true for default options, or provide LocalTelemetryOptions for custom config.
   */
  local?: LocalTelemetryOptions | boolean

  /**
   * Additional span processors to add to the tracer provider.
   * These are merged with the local processor (if enabled).
   */
  spanProcessors?: SpanProcessor[]

  /**
   * Additional span exporter to use.
   * Will be wrapped in a BatchSpanProcessor and merged with other processors.
   */
  traceExporter?: SpanExporter

  /**
   * Service name for OpenTelemetry resource.
   * @default 'duron'
   */
  serviceName?: string
}

/**
 * Base configuration options for a Duron client instance.
 * These options control job fetching, concurrency, and recovery behavior.
 */
export interface BaseOptionsInput {
  /**
   * Unique identifier for this Duron instance.
   * Used for instance identification, heartbeat liveness, and job ownership.
   * If not provided, a random UUID will be generated.
   *
   * @example 'worker-1', 'api-server', 'background-processor'
   */
  id?: string

  /**
   * Synchronization pattern for fetching jobs from the database.
   *
   * - `'pull'`: Periodically poll the database for new jobs at `pullInterval`
   * - `'push'`: Listen for database notifications when jobs are available (real-time)
   * - `'hybrid'`: Use both pull and push patterns (recommended for reliability)
   * - `false`: Disable automatic job fetching (use `fetch()` manually)
   *
   * @default 'hybrid'
   *
   * @example
   * ```typescript
   * // Real-time job processing with fallback polling
   * syncPattern: 'hybrid'
   *
   * // Disable auto-fetching for API-only servers
   * syncPattern: false
   * ```
   */
  syncPattern?: 'pull' | 'push' | 'hybrid' | false

  /**
   * Interval in milliseconds between pull operations when using `'pull'` or `'hybrid'` sync pattern.
   * Lower values mean faster job pickup but more database queries.
   *
   * @default 5000
   */
  pullInterval?: number

  /**
   * Maximum number of jobs to fetch in a single batch from the database.
   * Higher values reduce database round-trips but may increase memory usage.
   *
   * @default 10
   */
  batchSize?: number

  /**
   * Maximum number of jobs that can run concurrently per action.
   * This controls the concurrency limit for each action's internal queue.
   * Use this to prevent any single action from consuming all resources.
   *
   * @default 100
   */
  actionConcurrencyLimit?: number

  /**
   * Maximum number of jobs that can run concurrently per group key.
   * Jobs with the same group key will respect this limit.
   * This is the default value; it can be overridden per-job using `action.groups.concurrency`.
   *
   * @default 10
   *
   * @example
   * ```typescript
   * // Limit concurrent jobs per user to 2
   * groupConcurrencyLimit: 2
   * ```
   */
  groupConcurrencyLimit?: number

  /**
   * Whether to run database migrations on startup.
   * When enabled, Duron will automatically apply pending migrations when the adapter starts.
   * Disable this if you manage migrations separately or use a read-only database connection.
   *
   * @default true
   */
  migrateOnStart?: boolean

  /**
   * Whether to recover stuck jobs on startup.
   * Stuck jobs are jobs that were marked as active but the process that owned them
   * is no longer running (e.g., after a crash or restart).
   * These jobs will be reset to 'created' status so they can be picked up again.
   *
   * @default true
   */
  recoverJobsOnStart?: boolean

  /**
   * Interval in milliseconds between heartbeat updates.
   * Each instance periodically upserts a liveness record in the `clients` table.
   * Other instances use this to detect crashed owners during recovery.
   *
   * @default 5000
   */
  heartbeatInterval?: number

  /**
   * Milliseconds after which a client without a heartbeat is considered dead.
   * A dead client's active jobs are recovered (requeued or failed if expired).
   * Should be at least 3x heartbeatInterval to tolerate missed beats.
   *
   * @default 15000
   */
  heartbeatTimeout?: number

  /**
   * Interval in milliseconds between job recovery runs.
   * Recovery checks for expired or stuck jobs and handles them appropriately.
   * Set to `0` to disable periodic recovery (only runs on startup).
   *
   * @default 60000
   */
  recoverJobsInterval?: number
}

const BaseOptionsSchema = z.object({
  id: z.string().optional(),
  syncPattern: z
    .union([z.literal('pull'), z.literal('push'), z.literal('hybrid'), z.literal(false)])
    .default('hybrid'),
  pullInterval: z.number().default(5_000),
  batchSize: z.number().default(10),
  actionConcurrencyLimit: z.number().default(100),
  groupConcurrencyLimit: z.number().default(10),
  migrateOnStart: z.boolean().default(true),
  recoverJobsOnStart: z.boolean().default(true),
  heartbeatInterval: z.number().default(5000),
  heartbeatTimeout: z.number().default(15000),
  recoverJobsInterval: z.number().default(60_000),
})

// Compile-time check: ensure BaseOptionsInput is assignable to the Zod schema's input type
type _EnsureBaseOptionsCompatible =
  BaseOptionsInput extends z.input<typeof BaseOptionsSchema>
    ? true
    : 'ERROR: BaseOptionsInput does not match Zod schema input type'

declare const _baseOptionsCheck: _EnsureBaseOptionsCompatible
const _checkOptions: _EnsureBaseOptionsCompatible = true

/**
 * Options for configuring a Duron client instance.
 *
 * @template TActions - Record of action definitions keyed by action name
 * @template TVariables - Type of variables available to actions
 */
export interface ClientOptions<
  TActions extends Record<string, Action<any, any, TVariables>>,
  TVariables = Record<string, unknown>,
> extends BaseOptionsInput {
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

  /**
   * Optional telemetry configuration for observability.
   * Uses OpenTelemetry SDK for tracing.
   *
   * @example
   * ```typescript
   * // Enable local span storage (stored in the database)
   * telemetry: { local: true }
   *
   * // Enable local storage with custom flush delay
   * telemetry: { local: { flushDelayMs: 10000 } }
   *
   * // Export to external systems (e.g., OTLP)
   * telemetry: { traceExporter: new OTLPTraceExporter() }
   *
   * // Both local storage and external export
   * telemetry: { local: true, traceExporter: new OTLPTraceExporter() }
   * ```
   */
  telemetry?: TelemetryOptions
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
  #tracerProvider: NodeTracerProvider | null = null
  #tracer: Tracer
  #telemetryOptions: TelemetryOptions | null = null
  #localSpansEnabled: boolean = false
  #variables: Record<string, unknown>
  #logger: Logger
  #started: boolean = false
  #stopped: boolean = false
  #starting: Promise<boolean> | null = null
  #stopping: Promise<boolean> | null = null
  #pullInterval: NodeJS.Timeout | null = null
  #heartbeatTimer: NodeJS.Timeout | null = null
  #lastRecoveryAt: number = 0
  #actionManagers = new Map<string, ActionManager<Action<any, any, any>>>()
  #mockInputSchemas = new Map<string, any>()
  #pendingJobWaits = new Map<
    string,
    Set<{
      resolve: (result: JobResult | null) => void
      timeoutId?: NodeJS.Timeout
      signal?: AbortSignal
      abortHandler?: () => void
    }>
  >()
  #jobStatusListenerSetup = false
  #pushListenerSetup = false
  #jobStatusListener:
    | ((event: { jobId: string; status: JobStatus | 'retried'; clientId: string }) => Promise<void>)
    | null = null
  #pushListener: (() => void) | null = null

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
    this.#telemetryOptions = options.telemetry ?? null
    this.#actions = options.actions ?? null
    this.#variables = options?.variables ?? {}
    this.#logger = this.#normalizeLogger(options?.logger)
    this.#database.setId(this.#id)
    this.#database.setLogger(this.#logger)

    // Initialize OpenTelemetry TracerProvider if telemetry options are provided
    // When no options are provided, the tracer will be a no-op (from OpenTelemetry API)
    if (this.#telemetryOptions) {
      this.#initTelemetry(this.#telemetryOptions)
    }

    // Get tracer from our provider if configured, otherwise use global no-op tracer
    // This keeps telemetry scoped to this client instance rather than globally registered
    this.#tracer = this.#tracerProvider?.getTracer('duron') ?? trace.getTracer('duron')
  }

  /**
   * Initialize OpenTelemetry TracerProvider with configured processors.
   */
  #initTelemetry(options: TelemetryOptions): void {
    const serviceName = options.serviceName ?? 'duron'
    const processors: SpanProcessor[] = []

    // Add local span exporter if enabled
    if (options.local) {
      const localOptions = typeof options.local === 'boolean' ? {} : options.local
      const flushDelayMs = localOptions.flushDelayMs ?? 5000

      const localExporter = new LocalSpanExporter({ adapter: this.#database })
      processors.push(
        new BatchSpanProcessor(localExporter, {
          scheduledDelayMillis: flushDelayMs,
        }),
      )
      this.#localSpansEnabled = true
    }

    // Add custom span processors
    if (options.spanProcessors) {
      processors.push(...options.spanProcessors)
    }

    // Add custom trace exporter wrapped in BatchSpanProcessor
    if (options.traceExporter) {
      processors.push(new BatchSpanProcessor(options.traceExporter))
    }

    // Only create TracerProvider if we have processors
    if (processors.length > 0) {
      this.#tracerProvider = new NodeTracerProvider({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: serviceName,
        }),
        spanProcessors: processors,
      })
      // Note: We do NOT call .register() here to avoid global state pollution
      // The tracer is obtained directly from this provider instance
    }
  }

  #normalizeLogger(
    logger?: Logger | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent',
  ): Logger {
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
   * Get the OpenTelemetry tracer for creating custom spans.
   * Always returns a tracer - it's a no-op tracer when no SDK is configured.
   */
  get tracer(): Tracer {
    return this.#tracer
  }

  /**
   * Get the database adapter instance.
   */
  get database(): Adapter {
    return this.#database
  }

  /**
   * Check if local span storage is enabled.
   * Returns true if telemetry.local is enabled.
   */
  get spansEnabled(): boolean {
    return this.#localSpansEnabled
  }

  /**
   * Force flush any pending telemetry data.
   * Useful in tests or when you need to ensure spans are exported before querying.
   */
  async flushTelemetry(): Promise<void> {
    if (this.#tracerProvider) {
      await this.#tracerProvider.forceFlush()
    }
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

    // Calculate description if provided
    let description: string | null = null
    if (action.description) {
      description = await action.description(concurrencyCtx)
    }

    // Create job in database
    const jobId = await this.#database.createJob({
      queue: action.name,
      groupKey,
      input: validatedInput,
      timeoutMs: action.expire,
      checksum: action.checksum,
      concurrencyLimit,
      concurrencyStepLimit: action.steps.concurrency,
      description,
    })

    if (!jobId) {
      throw new Error(`Failed to create job for action ${String(actionName)}`)
    }

    this.#logger.debug(
      { jobId, actionName: String(actionName), groupKey },
      '[Duron] Action sent/created',
    )

    return jobId
  }

  /**
   * Run an action and wait for its completion.
   * This is a convenience method that combines `runAction` and `waitForJob`.
   *
   * @param actionName - Name of the action to run
   * @param input - Input data for the action (validated against action's input schema if provided)
   * @param options - Options including abort signal and timeout
   * @returns Promise resolving to the job result with typed input and output
   * @throws Error if action is not found, job creation fails, job is cancelled, or operation is aborted
   */
  async runActionAndWait<TActionName extends keyof TActions>(
    actionName: TActionName,
    input?: NonNullable<TActions[TActionName]['input']> extends z.ZodObject
      ? z.input<NonNullable<TActions[TActionName]['input']>>
      : never,
    options?: {
      /**
       * AbortSignal to cancel the operation. If aborted, the job will be cancelled and the promise will reject.
       */
      signal?: AbortSignal
      /**
       * Timeout in milliseconds. If the job doesn't complete within this time, the job will be cancelled and the promise will reject.
       */
      timeout?: number
    },
  ): Promise<TypedJobResult<TActions[TActionName]>> {
    // Check if already aborted before starting
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted')
    }

    // Create the job
    const jobId = await this.runAction(actionName, input)

    // Set up abort handler to cancel the job if signal is aborted
    let abortHandler: (() => void) | undefined
    if (options?.signal) {
      abortHandler = () => {
        this.cancelJob(jobId).catch((err) => {
          this.#logger.error({ err, jobId }, '[Duron] Error cancelling job on abort')
        })
      }
      options.signal.addEventListener('abort', abortHandler, { once: true })
    }

    // Set up timeout handler to cancel the job if timeout is reached
    let timeoutId: NodeJS.Timeout | undefined
    let timeoutAbortController: AbortController | undefined
    if (options?.timeout) {
      timeoutAbortController = new AbortController()
      timeoutId = setTimeout(() => {
        timeoutAbortController!.abort()
        this.cancelJob(jobId).catch((err) => {
          this.#logger.error({ err, jobId }, '[Duron] Error cancelling job on timeout')
        })
      }, options.timeout)
    }

    try {
      // Combine signals if both are provided
      let waitSignal: AbortSignal | undefined
      if (options?.signal && timeoutAbortController) {
        waitSignal = AbortSignal.any([options.signal, timeoutAbortController.signal])
      } else if (options?.signal) {
        waitSignal = options.signal
      } else if (timeoutAbortController) {
        waitSignal = timeoutAbortController.signal
      }

      // Wait for the job to complete
      const job = await this.waitForJob(jobId, { signal: waitSignal })

      // Clean up
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener('abort', abortHandler)
      }

      // Handle null result (aborted or timed out)
      if (!job) {
        if (options?.signal?.aborted) {
          throw new Error('Operation was aborted')
        }
        if (timeoutAbortController?.signal.aborted) {
          throw new Error('Operation timed out')
        }
        throw new Error('Job not found')
      }

      // Handle cancelled job
      if (job.status === JOB_STATUS_CANCELLED) {
        if (options?.signal?.aborted) {
          throw new Error('Operation was aborted')
        }
        if (timeoutAbortController?.signal.aborted) {
          throw new Error('Operation timed out')
        }
        throw new Error('Job was cancelled')
      }

      // Handle failed job
      if (job.status === JOB_STATUS_FAILED) {
        const errorMessage = job.error?.message ?? 'Job failed'
        const error = new Error(errorMessage)
        if (job.error?.stack) {
          error.stack = job.error.stack
        }
        throw error
      }

      // Return the job result with typed input/output
      return job as TypedJobResult<TActions[TActionName]>
    } catch (err) {
      // Clean up on error
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener('abort', abortHandler)
      }
      throw err
    }
  }

  /**
   * Fetch and process jobs from the database.
   * Concurrency limits are determined from the latest job created for each groupKey.
   *
   * @param [options.batchSize] - Maximum number of jobs to fetch in this batch (defaults to `batchSize` from client options)
   * @returns Promise resolving to the array of fetched jobs
   */
  async fetch(options: FetchOptions = {}) {
    await this.start()

    if (!this.#actions) {
      return []
    }

    // Run recovery periodically (time-based, always multi-process)
    const now = Date.now()
    if (
      this.#options.recoverJobsInterval > 0 &&
      now - this.#lastRecoveryAt > this.#options.recoverJobsInterval
    ) {
      this.#lastRecoveryAt = now
      await this.#database.recoverJobs({
        checksums: Object.values(this.#actions).map((action) => action.checksum),
        staleTimeoutMs: this.#options.heartbeatTimeout,
      })
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
   * Time travel a job to restart from a specific step.
   * The job must be in completed, failed, or cancelled status.
   * Resets the job and ancestor steps to active status, deletes subsequent steps,
   * and preserves completed parallel siblings.
   *
   * @param jobId - The ID of the job to time travel
   * @param stepId - The ID of the step to restart from
   * @returns Promise resolving to `true` if time travel succeeded, `false` otherwise
   */
  async timeTravelJob(jobId: string, stepId: string): Promise<boolean> {
    await this.start()
    return this.#database.timeTravelJob({ jobId, stepId })
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
   * When the job status changes, the job result is returned.
   *
   * @param jobId - The ID of the job to wait for
   * @param options - Optional configuration including timeout
   * @returns Promise resolving to the job result when its status changes, or `null` if timeout
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
  ): Promise<JobResult | null> {
    await this.start()

    // Set up the shared event listener if not already set up
    this.#setupJobStatusListener()

    // Register the wait BEFORE checking status to prevent TOCTOU race
    // If the job completes between status check and wait registration,
    // the NOTIFY would be missed
    let timeoutId: NodeJS.Timeout | undefined
    let abortHandler: (() => void) | undefined

    return new Promise<JobResult | null>((resolve) => {
      // Check if already aborted before setting up wait
      if (options?.signal?.aborted) {
        resolve(null)
        return
      }

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

      // Add this wait request to the pending waits BEFORE checking status
      if (!this.#pendingJobWaits.has(jobId)) {
        this.#pendingJobWaits.set(jobId, new Set())
      }
      this.#pendingJobWaits.get(jobId)!.add({
        resolve,
        timeoutId,
        signal: options?.signal,
        abortHandler,
      })

      // Now check if the job is already in a terminal state
      // If so, remove the wait and resolve immediately
      // Errors settle the wait as null to avoid hangs and leaked wait entries
      this.getJobStatus(jobId)
        .then((existingJobStatus) => {
          if (existingJobStatus) {
            const terminalStatuses: JobStatus[] = [
              JOB_STATUS_COMPLETED,
              JOB_STATUS_FAILED,
              JOB_STATUS_CANCELLED,
            ]
            if (terminalStatuses.includes(existingJobStatus.status)) {
              // Job is already terminal, remove the wait and resolve
              this.#removeJobWait(jobId, resolve)
              return this.getJobById(jobId).then((job) => {
                if (!job) {
                  resolve(null)
                } else {
                  resolve({
                    id: job.id,
                    actionName: job.actionName,
                    status: job.status,
                    groupKey: job.groupKey,
                    description: job.description,
                    input: job.input,
                    output: job.output,
                    error: job.error,
                  })
                }
              })
            }
          }
        })
        .catch((error) => {
          this.#logger.error({ error, jobId }, '[Duron] [waitForJob] Error checking job status')
          this.#removeJobWait(jobId, resolve)
          resolve(null)
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
   * Get spans for a job or step.
   * Only available when telemetry.local is enabled.
   *
   * @param options - Query options including jobId/stepId, filters, and sort
   * @returns Promise resolving to spans result
   * @throws Error if local telemetry is not enabled
   */
  async getSpans(options: GetSpansOptions): Promise<GetSpansResult> {
    await this.start()
    if (!this.spansEnabled) {
      throw new Error('Spans are only available when telemetry.local is enabled')
    }
    return this.#database.getSpans(options)
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
              .override(z.ZodBigInt, '4000' as any) // Convert BigInt to string for JSON serialization
              .override(z.ZodNumber, (schema, _ctx) => {
                const greaterThan = schema.def.checks?.find(
                  (check) => check._zod.def.check === 'greater_than',
                )?._zod.def as unknown as { value: number; inclusive: boolean }
                const lessThan = schema.def.checks?.find(
                  (check) => check._zod.def.check === 'less_than',
                )?._zod.def as unknown as { value: number; inclusive: boolean }

                if (greaterThan && lessThan) {
                  const min = greaterThan.inclusive ? greaterThan.value : greaterThan.value + 1
                  // For inclusive lessThan, we want to include the value, so max should be value + 1
                  // For exclusive lessThan, we want to exclude the value, so max is the value itself
                  const max = lessThan.inclusive ? lessThan.value + 1 : lessThan.value
                  // Ensure min < max
                  if (min >= max) {
                    return Math.floor(min)
                  }
                  return Math.floor(Math.random() * (max - min) + min)
                }

                if (greaterThan) {
                  const min = greaterThan.inclusive ? greaterThan.value : greaterThan.value + 1
                  const max = min + 1000 // Use 1000 as default range
                  return Math.floor(Math.random() * (max - min) + min)
                }

                if (lessThan) {
                  // For inclusive lessThan, we want to include the value, so max should be value + 1
                  // For exclusive lessThan, we want to exclude the value, so max is the value itself
                  const max = lessThan.inclusive ? lessThan.value + 1 : lessThan.value
                  return Math.floor(Math.random() * max)
                }

                return Math.floor(Math.random() * 1000)
              })
              .number({
                extreme_value_chance: 0.01,
              })
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
  // Archive Methods
  // ============================================================================

  /**
   * Get archive statistics including counts and oldest job date.
   *
   * @returns Promise resolving to archive statistics
   */
  async getArchiveStats(): Promise<ArchiveStats> {
    await this.start()
    return this.#database.getArchiveStats()
  }

  /**
   * Prune archived jobs older than the specified threshold.
   *
   * @param options - Prune options including olderThan, batchSize, maxBatches
   * @returns Promise resolving to number of deleted jobs
   */
  async pruneArchive(options: PruneArchiveOptions): Promise<number> {
    await this.start()
    return this.#database.pruneArchive(options)
  }

  /**
   * Truncate all archive data (jobs, steps, spans).
   * This is a destructive operation - use with caution.
   *
   * @returns Promise resolving when complete
   */
  async truncateArchive(): Promise<void> {
    await this.start()
    return this.#database.truncateArchive()
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

      // Initial heartbeat to register this instance as alive
      await this.#database.heartbeat()
      this.#scheduleHeartbeat()

      if (this.#actions) {
        if (this.#options.recoverJobsOnStart) {
          await this.#database.recoverJobs({
            checksums: Object.values(this.#actions).map((action) => action.checksum),
            staleTimeoutMs: this.#options.heartbeatTimeout,
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

    // Wait for any in-flight start() to complete before proceeding
    if (this.#starting) {
      await this.#starting
    }

    this.#stopping = (async () => {
      // Stop heartbeat timer
      if (this.#heartbeatTimer) {
        clearTimeout(this.#heartbeatTimer)
        this.#heartbeatTimer = null
      }

      // Stop pull loop
      if (this.#pullInterval) {
        clearTimeout(this.#pullInterval)
        this.#pullInterval = null
      }

      // Remove event listeners BEFORE stopping database to prevent use-after-close
      if (this.#jobStatusListener) {
        this.#database.off('job-status-changed', this.#jobStatusListener)
        this.#jobStatusListener = null
        this.#jobStatusListenerSetup = false
      }
      if (this.#pushListener) {
        this.#database.off('job-available', this.#pushListener)
        this.#pushListener = null
        this.#pushListenerSetup = false
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

      // Shutdown TracerProvider if configured
      if (this.#tracerProvider) {
        await this.#tracerProvider.shutdown()
      }

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

    this.#jobStatusListener = async (event: {
      jobId: string
      status: JobStatus | 'retried'
      clientId: string
    }) => {
      const pendingWaits = this.#pendingJobWaits.get(event.jobId)
      if (!pendingWaits || pendingWaits.size === 0) {
        return
      }

      // Fetch the job once for all pending waits
      const job = await this.getJobById(event.jobId)

      // Transform to JobResult
      const result: JobResult | null = job
        ? {
            id: job.id,
            actionName: job.actionName,
            status: job.status,
            groupKey: job.groupKey,
            description: job.description,
            input: job.input,
            output: job.output,
            error: job.error,
          }
        : null

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
        wait.resolve(result)
      }
    }

    this.#database.on('job-status-changed', this.#jobStatusListener)
  }

  /**
   * Remove a specific wait request from the pending waits.
   *
   * @param jobId - The job ID
   * @param resolve - The resolve function to remove
   */
  #removeJobWait(jobId: string, resolve: (result: JobResult | null) => void) {
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
      const error = {
        name: 'ActionNotFoundError',
        message: `Action "${job.actionName}" not found for job ${job.id}`,
      }
      this.#logger.warn(
        { jobId: job.id, actionName: job.actionName },
        `[Duron] Action not found for job ${job.id}`,
      )
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
        tracer: this.#tracer,
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
   * Schedule the next heartbeat. Uses recursive setTimeout (not setInterval)
   * to avoid overlapping calls if a heartbeat is slow.
   */
  #scheduleHeartbeat() {
    if (this.#stopped) {
      return
    }

    this.#heartbeatTimer = setTimeout(async () => {
      if (this.#stopped) {
        return
      }
      try {
        await this.#database.heartbeat()
      } catch {
        // Heartbeat failure is non-fatal — recovery will detect staleness
      }
      this.#scheduleHeartbeat()
    }, this.#options.heartbeatInterval)
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
    if (this.#pushListenerSetup) {
      return
    }

    this.#pushListenerSetup = true

    this.#pushListener = () => {
      this.fetch({
        batchSize: 1,
      }).catch((error) => {
        this.#logger.error({ error }, '[Duron] [PushListener] Error fetching job')
      })
    }

    this.#database.on('job-available', this.#pushListener)
  }
}
