import fastq from 'fastq'
import type { Logger } from 'pino'
import type { z } from 'zod'

import {
  type Action,
  type ActionHandlerContext,
  type StepDefinition,
  type StepDefinitionHandlerContext,
  type StepHandlerContext,
  type StepOptions,
  StepOptionsSchema,
} from './action.js'
import type { Adapter, CreateOrRecoverJobStepResult } from './adapters/adapter.js'
import { STEP_STATUS_CANCELLED, STEP_STATUS_COMPLETED, STEP_STATUS_FAILED, type StepStatus } from './constants.js'
import {
  ActionCancelError,
  isCancelError,
  isNonRetriableError,
  NonRetriableError,
  StepAlreadyExecutedError,
  StepTimeoutError,
  serializeError,
  UnhandledChildStepsError,
} from './errors.js'
import type { ObserveContext, Span, TelemetryAdapter } from './telemetry/adapter.js'
import pRetry from './utils/p-retry.js'
import waitForAbort from './utils/wait-for-abort.js'

export interface TaskStep {
  name: string
  cb: (ctx: StepHandlerContext) => Promise<any>
  options: StepOptions
  abortSignal: AbortSignal
  parentStepId: string | null
  parallel: boolean
}

/**
 * StepStore manages step records in the database.
 * Provides methods to create, update, and delay steps.
 */
export class StepStore {
  #adapter: Adapter

  // ============================================================================
  // Constructor
  // ============================================================================

  /**
   * Create a new StepStore instance.
   *
   * @param adapter - The database adapter to use for step operations
   */
  constructor(adapter: Adapter) {
    this.#adapter = adapter
  }

  // ============================================================================
  // Public API Methods
  // ============================================================================

  /**
   * Get or create a step record in the database.
   *
   * @param jobId - The ID of the job this step belongs to
   * @param name - The name of the step
   * @param timeoutMs - Timeout in milliseconds for the step
   * @param retriesLimit - Maximum number of retries for the step
   * @param parentStepId - The ID of the parent step (null for root steps)
   * @param parallel - Whether this step runs in parallel (independent from siblings during time travel)
   * @returns Promise resolving to the created step ID
   * @throws Error if step creation fails
   */
  async getOrCreate(
    jobId: string,
    name: string,
    timeoutMs: number,
    retriesLimit: number,
    parentStepId: string | null = null,
    parallel: boolean = false,
  ) {
    try {
      return await this.#adapter.createOrRecoverJobStep({
        jobId,
        name,
        timeoutMs,
        retriesLimit,
        parentStepId,
        parallel,
      })
    } catch (error) {
      throw new NonRetriableError(`Failed to get or create step "${name}" for job "${jobId}"`, { cause: error })
    }
  }

  /**
   * Update the status of a step in the database.
   *
   * @param stepId - The ID of the step to update
   * @param status - The new status (completed, failed, or cancelled)
   * @param output - Optional output data for completed steps
   * @param error - Optional error data for failed steps
   * @returns Promise resolving to `true` if update succeeded, `false` otherwise
   */
  async updateStatus(stepId: string, status: StepStatus, output?: any, error?: any): Promise<boolean> {
    if (status === STEP_STATUS_COMPLETED) {
      return this.#adapter.completeJobStep({ stepId, output })
    } else if (status === STEP_STATUS_FAILED) {
      return this.#adapter.failJobStep({ stepId, error })
    } else if (status === STEP_STATUS_CANCELLED) {
      return this.#adapter.cancelJobStep({ stepId })
    }
    return false
  }

  /**
   * Delay a step execution.
   * Used when a step fails and needs to be retried after a delay.
   *
   * @param stepId - The ID of the step to delay
   * @param delayMs - The delay in milliseconds before retrying
   * @param error - The error that caused the delay
   * @returns Promise resolving to `true` if delayed successfully, `false` otherwise
   */
  async delay(stepId: string, delayMs: number, error: any): Promise<boolean> {
    return this.#adapter.delayJobStep({ stepId, delayMs, error })
  }
}

export interface StepManagerOptions {
  jobId: string
  actionName: string
  adapter: Adapter
  telemetry: TelemetryAdapter
  logger: Logger
  concurrencyLimit: number
}

/**
 * StepManager manages steps for a single ActionJob.
 * Each ActionJob has its own StepManager instance.
 */
export class StepManager {
  #jobId: string
  #actionName: string
  #stepStore: StepStore
  #telemetry: TelemetryAdapter
  #queue: fastq.queueAsPromised<TaskStep, any>
  #logger: Logger
  // each step name should be executed only once per parent (name + parentStepId)
  #historySteps = new Set<string>()
  // Store step spans for nested step tracking
  #stepSpans = new Map<string, Span>()
  // Store the job span for creating step spans
  #jobSpan: Span | null = null
  // Factory function to create run functions with the correct parent step ID and abort signal
  #runFnFactory: ((parentStepId: string | null, abortSignal: AbortSignal) => StepHandlerContext['run']) | null = null

  // ============================================================================
  // Constructor
  // ============================================================================

  /**
   * Create a new StepManager instance.
   *
   * @param options - Configuration options for the step manager
   */
  constructor(options: StepManagerOptions) {
    this.#jobId = options.jobId
    this.#actionName = options.actionName
    this.#logger = options.logger
    this.#telemetry = options.telemetry
    this.#stepStore = new StepStore(options.adapter)
    this.#queue = fastq.promise(async (task: TaskStep) => {
      // Create composite key: name + parentStepId (allows same name under different parents)
      const stepKey = `${task.parentStepId ?? 'root'}:${task.name}`
      if (this.#historySteps.has(stepKey)) {
        throw new StepAlreadyExecutedError(task.name, this.#jobId, this.#actionName)
      }
      this.#historySteps.add(stepKey)
      return this.#executeStep(task.name, task.cb, task.options, task.abortSignal, task.parentStepId, task.parallel)
    }, options.concurrencyLimit)
  }

  /**
   * Set the job span for this step manager.
   * Called from ActionJob after the job span is created.
   */
  setJobSpan(span: Span): void {
    this.#jobSpan = span
  }

  /**
   * Set the run function factory for executing step definitions from inline steps.
   * Called from ActionContext after it's initialized.
   *
   * @param factory - A function that creates run functions with the correct parent step ID and abort signal
   */
  setRunFnFactory(factory: (parentStepId: string | null, abortSignal: AbortSignal) => StepHandlerContext['run']): void {
    this.#runFnFactory = factory
  }

  // ============================================================================
  // Public API Methods
  // ============================================================================

  /**
   * Create an ActionContext for the action handler.
   * The context provides access to input, variables, logger, and the step function.
   *
   * @param job - The job data including ID, input, and optional group key
   * @param action - The action definition
   * @param variables - Variables available to the action
   * @param abortSignal - Abort signal for cancelling the action
   * @param logger - Pino child logger for this job
   * @param observeContext - Observability context for telemetry
   * @returns ActionHandlerContext instance
   */
  createActionContext<TInput extends z.ZodObject, TOutput extends z.ZodObject, TVariables = Record<string, unknown>>(
    job: { id: string; input: z.infer<TInput>; groupKey?: string },
    action: Action<TInput, TOutput, TVariables>,
    variables: TVariables,
    abortSignal: AbortSignal,
    logger: Logger,
    observeContext: ObserveContext,
  ): ActionHandlerContext<TInput, TVariables> {
    return new ActionContext(this, job, action, variables, abortSignal, logger, observeContext)
  }

  /**
   * Create an observe context for a step.
   */
  createStepObserveContext(stepId: string): ObserveContext {
    const stepSpan = this.#stepSpans.get(stepId)
    if (stepSpan) {
      return this.#telemetry.createObserveContext(this.#jobId, stepId, stepSpan)
    }
    // Fallback to job span if step span not found
    if (this.#jobSpan) {
      return this.#telemetry.createObserveContext(this.#jobId, stepId, this.#jobSpan)
    }
    // No-op observe context
    return {
      recordMetric: () => {
        // No-op
      },
      addSpanAttribute: () => {
        // No-op
      },
      addSpanEvent: () => {
        // No-op
      },
    }
  }

  /**
   * Queue a step task for execution.
   *
   * @param task - The step task to queue
   * @returns Promise resolving to the step result
   */
  async push(task: TaskStep): Promise<any> {
    return this.#queue.push(task)
  }

  /**
   * Clean up step queues by waiting for them to drain.
   * Should be called when the job completes or is cancelled.
   */
  async drain(): Promise<void> {
    await this.#queue.drain()
  }

  /**
   * Execute a step with retry logic and timeout handling.
   * Creates a step record, queues the execution, and handles errors appropriately.
   *
   * @param name - The name of the step
   * @param cb - The step handler function
   * @param options - Step options including concurrency, retry, and expire settings
   * @param abortSignal - Abort signal for cancelling the step
   * @param parentStepId - The ID of the parent step (null for root steps)
   * @returns Promise resolving to the step result
   * @throws StepTimeoutError if the step times out
   * @throws StepCancelError if the step is cancelled
   * @throws UnhandledChildStepsError if child steps are not awaited
   * @throws Error if the step fails
   */
  async #executeStep<TResult>(
    name: string,
    cb: (ctx: StepHandlerContext) => Promise<TResult>,
    options: StepOptions,
    abortSignal: AbortSignal,
    parentStepId: string | null,
    parallel: boolean,
  ): Promise<TResult> {
    const expire = options.expire
    const retryOptions = options.retry
    let step: CreateOrRecoverJobStepResult | null = null

    const executeStep = async (): Promise<TResult> => {
      if (!step) {
        if (abortSignal.aborted) {
          throw new ActionCancelError(this.#actionName, this.#jobId, { cause: 'step cancelled before create step' })
        }

        // Create step record with parentStepId and parallel
        const newStep = await this.#stepStore.getOrCreate(
          this.#jobId,
          name,
          expire,
          retryOptions.limit,
          parentStepId,
          parallel,
        )
        if (!newStep) {
          throw new NonRetriableError(
            `Failed to create step "${name}" for job "${this.#jobId}" action "${this.#actionName}"`,
            { cause: 'step not created' },
          )
        }

        step = newStep

        // Start step telemetry span
        const parentSpan = parentStepId ? this.#stepSpans.get(parentStepId) : this.#jobSpan
        const stepSpan = await this.#telemetry.startStepSpan({
          jobId: this.#jobId,
          stepId: step.id,
          stepName: name,
          parentSpan: parentSpan ?? undefined,
          parentStepId,
        })
        this.#stepSpans.set(step.id, stepSpan)

        if (abortSignal.aborted) {
          throw new ActionCancelError(this.#actionName, this.#jobId, { cause: 'step cancelled after create step' })
        }

        if (step.status === STEP_STATUS_COMPLETED) {
          // this is how we recover a completed step
          this.#logger.debug(
            { jobId: this.#jobId, actionName: this.#actionName, stepName: name, stepId: step.id, parentStepId },
            '[StepManager] Step recovered (already completed)',
          )
          return step.output as TResult
        } else if (step.status === STEP_STATUS_FAILED) {
          throw new NonRetriableError(
            `Cannot recover a failed step "${name}" for job "${this.#jobId}" action "${this.#actionName}"`,
            {
              cause: step.error,
            },
          )
        } else if (step.status === STEP_STATUS_CANCELLED) {
          throw new NonRetriableError(
            `Cannot recover a cancelled step "${name}" for job "${this.#jobId}" action "${this.#actionName}"`,
            { cause: step.error },
          )
        }

        // Log step start
        this.#logger.debug(
          { jobId: this.#jobId, actionName: this.#actionName, stepName: name, stepId: step.id, parentStepId },
          '[StepManager] Step started executing',
        )
      }

      // Create abort controller for this step's timeout
      const stepAbortController = new AbortController()
      const timeoutId = setTimeout(() => {
        const timeoutError = new StepTimeoutError(name, this.#jobId, expire)
        stepAbortController.abort(timeoutError)
      }, expire)

      timeoutId?.unref?.()

      // Combine abort signals: parent chain + this step's timeout
      const stepSignal = AbortSignal.any([abortSignal, stepAbortController.signal])

      // Track child steps for enforcement
      interface TrackedChildStep {
        promise: Promise<any>
        settled: boolean
      }
      const childSteps: TrackedChildStep[] = []

      // Create abort controller for child steps (used when parent returns with pending children)
      const childAbortController = new AbortController()
      const childSignal = AbortSignal.any([stepSignal, childAbortController.signal])

      // Create observe context for this step
      const stepObserveContext = this.createStepObserveContext(step.id)

      // Create StepHandlerContext with nested step support
      const stepContext: StepHandlerContext = {
        signal: stepSignal,
        stepId: step.id,
        parentStepId,
        observe: stepObserveContext,
        step: <TChildResult>(
          childName: string,
          childCb: (ctx: StepHandlerContext) => Promise<TChildResult>,
          childOptions: z.input<typeof StepOptionsSchema> = {},
        ): Promise<TChildResult> => {
          // Inherit parent step options EXCEPT parallel (each step's parallel status is independent)
          const { parallel: _parentParallel, ...inheritableOptions } = options
          const parsedChildOptions = StepOptionsSchema.parse({
            ...inheritableOptions,
            ...childOptions,
          })

          // Push child step with this step as parent
          const childPromise = this.push({
            name: childName,
            cb: childCb,
            options: parsedChildOptions,
            abortSignal: childSignal, // Child uses composed signal
            parentStepId: step!.id, // This step is the parent
            parallel: parsedChildOptions.parallel, // Pass parallel option
          })

          // Track the child promise
          const trackedChild: TrackedChildStep = {
            promise: childPromise,
            settled: false,
          }
          childSteps.push(trackedChild)

          // Mark as settled when done (success or failure)
          // Use .then/.catch instead of .finally to properly handle rejections
          childPromise
            .then(() => {
              trackedChild.settled = true
            })
            .catch(() => {
              trackedChild.settled = true
              // Swallow the error here - it will be re-thrown to the caller via the returned promise
            })

          return childPromise
        },
        run: this.#runFnFactory!(step.id, childSignal),
      }

      try {
        // Race between abort signal and callback execution
        const abortPromise = waitForAbort(stepSignal)
        const callbackPromise = cb(stepContext)

        let result: any = null
        let aborted = false

        await Promise.race([
          abortPromise.promise.then(() => {
            aborted = true
          }),
          callbackPromise
            .then((res) => {
              if (res !== undefined && res !== null) {
                result = res
              }
            })
            .finally(() => {
              abortPromise.release()
            }),
        ])

        // If aborted, wait for child steps to settle before propagating
        if (aborted) {
          // Wait for all child steps to settle (they'll be aborted via signal propagation)
          if (childSteps.length > 0) {
            await Promise.allSettled(childSteps.map((c) => c.promise))
          }
          // Re-throw the abort reason
          throw stepSignal.reason
        }

        // After parent callback returns, check for pending children
        const unsettledChildren = childSteps.filter((c) => !c.settled)
        if (unsettledChildren.length > 0) {
          this.#logger.warn(
            {
              jobId: this.#jobId,
              actionName: this.#actionName,
              stepName: name,
              stepId: step.id,
              pendingCount: unsettledChildren.length,
            },
            '[StepManager] Parent step completed with unhandled child steps - aborting children',
          )

          // Abort all pending children
          const unhandledError = new UnhandledChildStepsError(name, unsettledChildren.length)
          childAbortController.abort(unhandledError)

          // Wait for all children to settle (they'll reject with cancellation)
          await Promise.allSettled(unsettledChildren.map((c) => c.promise))

          // Now throw the error
          throw unhandledError
        }

        // Update step as completed
        const completed = await this.#stepStore.updateStatus(step.id, 'completed', result)
        if (!completed) {
          throw new Error(`Failed to complete step "${name}" for job "${this.#jobId}" action "${this.#actionName}"`)
        }

        // End step telemetry span successfully
        const stepSpan = this.#stepSpans.get(step.id)
        if (stepSpan) {
          await this.#telemetry.endStepSpan(stepSpan, { status: 'ok' })
          this.#stepSpans.delete(step.id)
        }

        // Log step completion
        this.#logger.debug(
          { jobId: this.#jobId, actionName: this.#actionName, stepName: name, stepId: step.id },
          '[StepManager] Step finished executing',
        )

        return result as TResult
      } finally {
        clearTimeout(timeoutId)
      }
    }

    // Apply retry logic - skip retries for NonRetriableError
    return pRetry(executeStep, {
      retries: retryOptions.limit,
      factor: retryOptions.factor,
      randomize: false,
      signal: abortSignal,
      minTimeout: retryOptions.minTimeout,
      maxTimeout: retryOptions.maxTimeout,
      onFailedAttempt: async (ctx) => {
        const error = ctx.error as any
        // Don't retry if error is non-retriable
        if (
          isNonRetriableError(error) ||
          (error.cause && isNonRetriableError(error.cause)) ||
          (error instanceof Error && error.name === 'AbortError' && isNonRetriableError(error.cause))
        ) {
          throw error
        }

        if (ctx.retriesLeft > 0 && step) {
          const delayed = await this.#stepStore.delay(step.id, ctx.finalDelay, serializeError(error))
          if (!delayed) {
            throw new Error(`Failed to delay step "${name}" for job "${this.#jobId}" action "${this.#actionName}"`)
          }
        }
      },
    }).catch(async (error) => {
      if (step) {
        // End step telemetry span with error/cancelled status
        const stepSpan = this.#stepSpans.get(step.id)
        if (stepSpan) {
          if (isCancelError(error)) {
            await this.#telemetry.endStepSpan(stepSpan, { status: 'cancelled' })
          } else {
            await this.#telemetry.endStepSpan(stepSpan, { status: 'error', error })
          }
          this.#stepSpans.delete(step.id)
        }

        if (isCancelError(error)) {
          await this.#stepStore.updateStatus(step.id, 'cancelled')
        } else {
          await this.#stepStore.updateStatus(step.id, STEP_STATUS_FAILED, null, serializeError(error))
        }
      }
      throw error
    })
  }
}

// ============================================================================
// ActionContext Class
// ============================================================================

/**
 * ActionContext provides the context for action handlers.
 * It implements ActionHandlerContext and provides access to input, variables, logger, and the step function.
 */
class ActionContext<TInput extends z.ZodObject, TOutput extends z.ZodObject, TVariables = Record<string, unknown>>
  implements ActionHandlerContext<TInput, TVariables>
{
  #stepManager: StepManager
  #variables: TVariables
  #abortSignal: AbortSignal
  #logger: Logger
  #input: z.infer<TInput>
  #jobId: string
  #groupKey: string = '@default'
  #action: Action<TInput, TOutput, TVariables>
  #observeContext: ObserveContext

  // ============================================================================
  // Constructor
  // ============================================================================

  constructor(
    stepManager: StepManager,
    job: { id: string; input: z.infer<TInput>; groupKey?: string },
    action: Action<TInput, TOutput, TVariables>,
    variables: TVariables,
    abortSignal: AbortSignal,
    logger: Logger,
    observeContext: ObserveContext,
  ) {
    this.#stepManager = stepManager
    this.#variables = variables
    this.#abortSignal = abortSignal
    this.#logger = logger
    this.#action = action
    this.#jobId = job.id
    this.#groupKey = job.groupKey ?? '@default'
    this.#observeContext = observeContext
    if (action.input) {
      this.#input = action.input.parse(job.input, {
        error: () => 'Error parsing action input',
        reportInput: true,
      })
    }
    this.#input = job.input ?? {}
    this.step = this.step.bind(this)
    this.run = this.run.bind(this)
    // Set the run function factory so inline steps can call step definitions with correct parent
    this.#stepManager.setRunFnFactory((parentStepId, abortSignal) => {
      return (stepDef, input, options) => this.#runInternal(stepDef, input, options, parentStepId, abortSignal)
    })
  }

  // ============================================================================
  // Public API Methods
  // ============================================================================

  /**
   * Get the input data for this action.
   */
  get input(): z.infer<TInput> {
    return this.#input
  }

  /**
   * Get the job ID for this action context.
   *
   * @returns The job ID
   */
  get jobId(): string {
    return this.#jobId
  }

  /**
   * Get the group key for this action context.
   *
   * @returns The group key
   */
  get groupKey(): string {
    return this.#groupKey
  }

  /**
   * Get the variables available to this action.
   */
  get var(): TVariables {
    return this.#variables
  }

  /**
   * Get the logger for this action job.
   */
  get logger(): Logger {
    return this.#logger
  }

  /**
   * Get the observability context for recording metrics and span data.
   */
  get observe(): ObserveContext {
    return this.#observeContext
  }

  /**
   * Execute a step within the action.
   * This creates a root step (no parent).
   *
   * @param name - The name of the step
   * @param cb - The step handler function
   * @param options - Optional step options (will be merged with defaults)
   * @returns Promise resolving to the step result
   */
  async step<TResult>(
    name: string,
    cb: (ctx: StepHandlerContext) => Promise<TResult>,
    options: z.input<typeof StepOptionsSchema> = {},
  ): Promise<TResult> {
    const parsedOptions = StepOptionsSchema.parse({
      ...this.#action.steps,
      ...options,
    })
    return this.#stepManager.push({
      name,
      cb,
      options: parsedOptions,
      abortSignal: this.#abortSignal,
      parentStepId: null, // Root steps have no parent
      parallel: parsedOptions.parallel, // Pass parallel option
    })
  }

  /**
   * Execute a reusable step definition created with createStep().
   * This is the public method called from action handlers.
   *
   * @param stepDef - The step definition to execute
   * @param input - The input data for the step (validated against the step's input schema)
   * @param options - Optional step configuration overrides
   * @returns Promise resolving to the step result
   */
  async run<TStepInput extends z.ZodObject, TResult>(
    stepDef: StepDefinition<TStepInput, TResult, TVariables>,
    input: z.input<TStepInput>,
    options: Partial<z.input<typeof StepOptionsSchema>> = {},
  ): Promise<TResult> {
    return this.#runInternal(stepDef, input, options, null, this.#abortSignal)
  }

  /**
   * Internal method to execute a step definition with explicit parent step ID and abort signal.
   * Used by both the public run method and the run functions passed to step contexts.
   */
  async #runInternal<TStepInput extends z.ZodObject, TResult>(
    stepDef: StepDefinition<TStepInput, TResult, TVariables>,
    input: z.input<TStepInput>,
    options: Partial<z.input<typeof StepOptionsSchema>> = {},
    parentStepId: string | null,
    abortSignal: AbortSignal,
  ): Promise<TResult> {
    // Validate input against the step's schema if provided
    // After parsing, validatedInput is z.output<TStepInput> (same as z.infer<TStepInput>)
    const validatedInput: z.infer<TStepInput> = stepDef.input
      ? stepDef.input.parse(input, {
          error: () => 'Error parsing step input',
          reportInput: true,
        })
      : (input as z.infer<TStepInput>)

    // Resolve step name (static or dynamic)
    const stepName = typeof stepDef.name === 'function' ? stepDef.name({ input: validatedInput }) : stepDef.name

    // Merge options: action defaults -> step definition -> call-time overrides
    const mergedOptions: z.input<typeof StepOptionsSchema> = {
      ...this.#action.steps,
      ...(stepDef.retry !== undefined && { retry: stepDef.retry }),
      ...(stepDef.expire !== undefined && { expire: stepDef.expire }),
      ...(stepDef.parallel !== undefined && { parallel: stepDef.parallel }),
      ...options,
    }

    const parsedOptions = StepOptionsSchema.parse(mergedOptions)

    // Create a wrapper callback that provides the extended context
    const wrappedCb = async (baseCtx: StepHandlerContext): Promise<TResult> => {
      const extendedCtx: StepDefinitionHandlerContext<TStepInput, TVariables> = {
        ...baseCtx,
        input: validatedInput,
        var: this.#variables,
        logger: this.#logger,
        jobId: this.#jobId,
      }
      return stepDef.handler(extendedCtx)
    }

    return this.#stepManager.push({
      name: stepName,
      cb: wrappedCb,
      options: parsedOptions,
      abortSignal,
      parentStepId,
      parallel: parsedOptions.parallel,
    })
  }
}
