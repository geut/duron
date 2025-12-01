import fastq from 'fastq'
import type { Logger } from 'pino'
import type { z } from 'zod'

import {
  type Action,
  type ActionHandlerContext,
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
} from './errors.js'
import pRetry from './utils/p-retry.js'
import waitForAbort from './utils/wait-for-abort.js'

export interface TaskStep {
  name: string
  cb: (ctx: StepHandlerContext) => Promise<any>
  options: StepOptions
  abortSignal: AbortSignal
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
   * @returns Promise resolving to the created step ID
   * @throws Error if step creation fails
   */
  async getOrCreate(jobId: string, name: string, timeoutMs: number, retriesLimit: number) {
    try {
      return await this.#adapter.createOrRecoverJobStep({
        jobId,
        name,
        timeoutMs,
        retriesLimit,
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
  #queue: fastq.queueAsPromised<TaskStep, any>
  #logger: Logger
  // each step name should be executed only once per action job
  #historySteps = new Set<string>()

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
    this.#stepStore = new StepStore(options.adapter)
    this.#queue = fastq.promise(async (task: TaskStep) => {
      if (this.#historySteps.has(task.name)) {
        throw new StepAlreadyExecutedError(task.name, this.#jobId, this.#actionName)
      }
      this.#historySteps.add(task.name)
      return this.#executeStep(task.name, task.cb, task.options, task.abortSignal)
    }, options.concurrencyLimit)
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
   * @returns ActionHandlerContext instance
   */
  createActionContext<TInput extends z.ZodObject, TOutput extends z.ZodObject, TVariables = Record<string, unknown>>(
    job: { id: string; input: z.infer<TInput>; groupKey?: string },
    action: Action<TInput, TOutput, TVariables>,
    variables: TVariables,
    abortSignal: AbortSignal,
    logger: Logger,
  ): ActionHandlerContext<TInput, TVariables> {
    return new ActionContext(this, job, action, variables, abortSignal, logger)
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
   * @returns Promise resolving to the step result
   * @throws StepTimeoutError if the step times out
   * @throws StepCancelError if the step is cancelled
   * @throws Error if the step fails
   */
  async #executeStep<TResult>(
    name: string,
    cb: (ctx: StepHandlerContext) => Promise<TResult>,
    options: StepOptions,
    abortSignal: AbortSignal,
  ): Promise<TResult> {
    const expire = options.expire
    const retryOptions = options.retry
    let step: CreateOrRecoverJobStepResult | null = null

    const executeStep = async (): Promise<TResult> => {
      if (!step) {
        if (abortSignal.aborted) {
          throw new ActionCancelError(this.#actionName, this.#jobId, { cause: 'step cancelled before create step' })
        }

        // Create step record
        const newStep = await this.#stepStore.getOrCreate(this.#jobId, name, expire, retryOptions.limit)
        if (!newStep) {
          throw new NonRetriableError(
            `Failed to create step "${name}" for job "${this.#jobId}" action "${this.#actionName}"`,
            { cause: 'step not created' },
          )
        }

        step = newStep

        if (abortSignal.aborted) {
          throw new ActionCancelError(this.#actionName, this.#jobId, { cause: 'step cancelled after create step' })
        }

        if (step.status === STEP_STATUS_COMPLETED) {
          // this is how we recover a completed step
          this.#logger.debug(
            { jobId: this.#jobId, actionName: this.#actionName, stepName: name, stepId: step.id },
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
          { jobId: this.#jobId, actionName: this.#actionName, stepName: name, stepId: step.id },
          '[StepManager] Step started executing',
        )
      }

      const stepAbortController = new AbortController()
      const timeoutId = setTimeout(() => {
        const timeoutError = new StepTimeoutError(name, this.#jobId, expire)
        stepAbortController.abort(timeoutError)
      }, expire)

      timeoutId?.unref?.()

      // Combine abort signals
      const signal = AbortSignal.any([abortSignal, stepAbortController.signal])

      try {
        // Race between abort signal and callback execution
        const abortPromise = waitForAbort(signal)
        const callbackPromise = cb({ signal })

        let result: any = null

        await Promise.race([
          abortPromise.promise,
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

        // Update step as completed
        const completed = await this.#stepStore.updateStatus(step.id, 'completed', result)
        if (!completed) {
          throw new Error(`Failed to complete step "${name}" for job "${this.#jobId}" action "${this.#actionName}"`)
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
  ) {
    this.#stepManager = stepManager
    this.#variables = variables
    this.#abortSignal = abortSignal
    this.#logger = logger
    this.#action = action
    this.#jobId = job.id
    this.#groupKey = job.groupKey ?? '@default'
    if (action.input) {
      this.#input = action.input.parse(job.input, {
        error: () => 'Error parsing action input',
        reportInput: true,
      })
    }
    this.#input = job.input ?? {}
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
   * Execute a step within the action.
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
    return this.#stepManager.push({ name, cb, options: parsedOptions, abortSignal: this.#abortSignal })
  }
}
