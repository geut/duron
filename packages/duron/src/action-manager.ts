import fastq from 'fastq'
import type { Logger } from 'pino'

import type { Action } from './action.js'
import { ActionJob } from './action-job.js'
import type { Adapter, Job } from './adapters/adapter.js'

export interface ActionManagerOptions<TAction extends Action<any, any, any>> {
  action: TAction
  database: Adapter
  variables: Record<string, unknown>
  logger: Logger
  concurrencyLimit: number
}

/**
 * ActionManager manages the execution of jobs for a specific action.
 * Uses a fastq queue to control concurrency and process jobs.
 *
 * @template TAction - The action type being managed
 */
export class ActionManager<TAction extends Action<any, any, any>> {
  #action: TAction
  #database: Adapter
  #variables: Record<string, unknown>
  #logger: Logger
  #queue: fastq.queueAsPromised<Job, void>
  #concurrencyLimit: number
  #activeJobs = new Map<string, ActionJob<TAction>>()
  #stopped: boolean = false

  // ============================================================================
  // Constructor
  // ============================================================================

  /**
   * Create a new ActionManager instance.
   *
   * @param options - Configuration options for the action manager
   */
  constructor(options: ActionManagerOptions<TAction>) {
    this.#action = options.action
    this.#database = options.database
    this.#variables = options.variables
    this.#logger = options.logger
    this.#concurrencyLimit = options.concurrencyLimit

    // Create fastq queue with action concurrency limit
    this.#queue = fastq.promise(async (job: Job) => {
      if (this.#stopped) {
        return
      }

      await this.#executeJob(job)
    }, this.#concurrencyLimit)
  }

  // ============================================================================
  // Public API Methods
  // ============================================================================

  /**
   * Queue a job for execution.
   *
   * @param job - The job to queue
   * @returns Promise that resolves when the job is queued
   */
  async push(job: Job): Promise<void> {
    return this.#queue.push(job)
  }

  /**
   * Cancel a specific job by ID.
   *
   * @param jobId - The ID of the job to cancel
   * @returns If the manager has the job, it will be cancelled and true will be returned. Otherwise, false will be returned.
   */
  cancelJob(jobId: string) {
    const actionJob = this.#activeJobs.get(jobId)
    if (actionJob) {
      actionJob.cancel()
      return true
    }
    return false
  }

  /**
   * Cancel all active jobs.
   */
  abortAll(): void {
    for (const actionJob of this.#activeJobs.values()) {
      actionJob.cancel()
    }
  }

  /**
   * Check if the queue is idle (no jobs being processed).
   *
   * @returns Promise resolving to `true` if idle, `false` otherwise
   */
  async idle(): Promise<boolean> {
    return this.#queue.idle()
  }

  /**
   * Wait for the queue to drain (all jobs completed).
   *
   * @returns Promise that resolves when the queue is drained
   */
  async drain(): Promise<void> {
    return this.#queue.drain()
  }

  /**
   * Stop the action manager.
   * Aborts all active jobs and waits for the queue to drain.
   *
   * @returns Promise that resolves when the action manager is stopped
   */
  async stop(): Promise<void> {
    if (this.#stopped) {
      return
    }

    this.#stopped = true
    this.abortAll()
    await this.#queue.killAndDrain()
    await Promise.all(Array.from(this.#activeJobs.values()).map((actionJob) => actionJob.waitForDone()))
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Execute a job by creating an ActionJob and running it.
   *
   * @param job - The job to execute
   */
  async #executeJob(job: Job) {
    // Create ActionJob for this job
    const actionJob = new ActionJob({
      job: {
        id: job.id,
        input: job.input,
        groupKey: job.groupKey,
        timeoutMs: job.timeoutMs,
        actionName: job.actionName,
      },
      action: this.#action,
      database: this.#database,
      variables: this.#variables,
      logger: this.#logger,
    })
    this.#activeJobs.set(job.id, actionJob)

    try {
      // Execute the job - all error handling is done inside ActionJob.execute()
      await actionJob.execute()
    } finally {
      // Always cleanup, even if the job failed or was cancelled
      // Errors are already handled in ActionJob.execute() (logging, failing job, etc.)
      this.#activeJobs.delete(job.id)
    }
  }
}
