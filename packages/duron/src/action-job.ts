import { context, type Span, SpanKind, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api'
import type { Logger } from 'pino'

import type { Action } from './action.js'
import type { Adapter } from './adapters/adapter.js'
import { ActionCancelError, ActionTimeoutError, isCancelError, isTimeoutError, serializeError } from './errors.js'
import { StepManager } from './step-manager.js'
import waitForAbort from './utils/wait-for-abort.js'

export interface ActionJobOptions<TAction extends Action<any, any, any>> {
  job: { id: string; input: any; groupKey: string; timeoutMs: number; actionName: string }
  action: TAction
  database: Adapter
  tracer: Tracer | null
  variables: Record<string, unknown>
  logger: Logger
}

/**
 * ActionJob represents a single job execution for an action.
 * Manages the execution lifecycle, timeout handling, and cancellation.
 *
 * @template TAction - The action type being executed
 */
export class ActionJob<TAction extends Action<any, any, any>> {
  #job: { id: string; input: any; groupKey: string; timeoutMs: number; actionName: string }
  #action: TAction
  #database: Adapter
  #tracer: Tracer | null
  #variables: Record<string, unknown>
  #logger: Logger
  #stepManager: StepManager
  #abortController: AbortController
  #timeoutId: NodeJS.Timeout | null = null
  #done: Promise<void>
  #resolve: (() => void) | null = null
  #jobSpan: Span | null = null

  // ============================================================================
  // Constructor
  // ============================================================================

  /**
   * Create a new ActionJob instance.
   *
   * @param options - Configuration options for the action job
   */
  constructor(options: ActionJobOptions<TAction>) {
    this.#job = options.job
    this.#action = options.action
    this.#database = options.database
    this.#tracer = options.tracer
    this.#variables = options.variables
    this.#logger = options.logger
    this.#abortController = new AbortController()

    // Create StepManager for this job
    this.#stepManager = new StepManager({
      jobId: options.job.id,
      actionName: options.job.actionName,
      adapter: options.database,
      tracer: options.tracer,
      logger: options.logger,
      concurrencyLimit: options.action.steps.concurrency,
    })

    this.#done = new Promise((resolve) => {
      this.#resolve = resolve
    })
  }

  // ============================================================================
  // Public API Methods
  // ============================================================================

  /**
   * Execute the action job.
   * Creates the action context, sets up timeout, executes the handler,
   * validates output, and marks the job as completed or failed.
   *
   * @returns Promise resolving to the action result
   * @throws ActionTimeoutError if the job times out
   * @throws ActionCancelError if the job is cancelled
   * @throws Error if the job fails or output validation fails
   */
  async execute() {
    // Start job span if tracer is available
    if (this.#tracer) {
      this.#jobSpan = this.#tracer.startSpan(`job:${this.#action.name}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          'duron.job.id': this.#job.id,
          'duron.action.name': this.#action.name,
          'duron.group.key': this.#job.groupKey,
        },
      })
    }

    // Set the job span on the step manager
    this.#stepManager.setJobSpan(this.#jobSpan)

    try {
      // Create a child logger for this job
      const jobLogger = this.#logger.child({
        jobId: this.#job.id,
        actionName: this.#action.name,
      })

      // Create action context with step manager
      const ctx = this.#stepManager.createActionContext(
        this.#job,
        this.#action,
        this.#variables as any,
        this.#abortController.signal,
        jobLogger,
      )

      this.#timeoutId = setTimeout(() => {
        const timeoutError = new ActionTimeoutError(this.#action.name, this.#job.id, this.#job.timeoutMs)
        this.#abortController.abort(timeoutError)
      }, this.#job.timeoutMs)

      this.#timeoutId?.unref?.()

      // Execute handler with timeout - race between handler and abort signal
      const abortWaiter = waitForAbort(this.#abortController.signal)
      let result: any = null

      // Execute handler within the job span context so that child spans inherit the trace
      const spanContext = this.#jobSpan ? trace.setSpan(context.active(), this.#jobSpan) : context.active()

      await Promise.race([
        context
          .with(spanContext, () => this.#action.handler(ctx))
          .then((res) => {
            if (res !== undefined) {
              result = res
            }
          })
          .finally(() => {
            abortWaiter.release()
          }),
        abortWaiter.promise,
      ])

      // Validate output if schema is provided
      if (this.#action.output) {
        result = this.#action.output.parse(result, {
          error: () => 'Error parsing action output',
          reportInput: true,
        })
      }

      // Complete job
      const completed = await this.#database.completeJob({ jobId: this.#job.id, output: result })
      if (!completed) {
        throw new Error('Job not completed')
      }

      // Log action completion
      this.#logger.debug(
        { jobId: this.#job.id, actionName: this.#action.name },
        '[ActionJob] Action finished executing',
      )

      // End job span successfully
      if (this.#jobSpan) {
        this.#jobSpan.setStatus({ code: SpanStatusCode.OK })
        this.#jobSpan.end()
      }

      return result
    } catch (error) {
      // Abort all running steps when an error occurs
      // This ensures cascading failure and stops any steps still running
      if (!this.#abortController.signal.aborted) {
        this.#abortController.abort(error)
      }

      // Wait for step manager to drain (all steps to settle)
      await this.#stepManager.drain()

      if (
        isCancelError(error) ||
        (error instanceof Error && error.name === 'AbortError' && isCancelError(error.cause))
      ) {
        this.#logger.warn({ jobId: this.#job.id, actionName: this.#action.name }, '[ActionJob] Job cancelled')
        await this.#database.cancelJob({ jobId: this.#job.id })

        // End job span as cancelled
        if (this.#jobSpan) {
          this.#jobSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'Job cancelled' })
          this.#jobSpan.end()
        }
        return
      }

      const message = isTimeoutError(error) ? '[ActionJob] Job timed out' : '[ActionJob] Job failed'

      this.#logger.error({ jobId: this.#job.id, actionName: this.#action.name }, message)
      await this.#database.failJob({ jobId: this.#job.id, error: serializeError(error) })

      // End job span with error
      if (this.#jobSpan) {
        this.#jobSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        })
        if (error instanceof Error) {
          this.#jobSpan.recordException(error)
        }
        this.#jobSpan.end()
      }

      throw error
    } finally {
      this.#clear()
      this.#resolve?.()
    }
  }

  /**
   * Wait for the job execution to complete.
   * Returns a promise that resolves when the job finishes (successfully or with error).
   *
   * @returns Promise that resolves when the job is done
   */
  waitForDone(): Promise<void> {
    return this.#done
  }

  /**
   * Cancel the job execution.
   * Clears the timeout and aborts the action handler.
   */
  cancel() {
    this.#clear()
    const cancelError = new ActionCancelError(this.#action.name, this.#job.id)
    this.#abortController.abort(cancelError)
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Clear the timeout timer.
   */
  #clear() {
    if (this.#timeoutId) {
      clearTimeout(this.#timeoutId)
      this.#timeoutId = null
    }
  }
}
