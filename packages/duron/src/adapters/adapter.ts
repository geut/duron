import { EventEmitter } from 'node:events'

import type { Logger } from 'pino'
import { z } from 'zod'

import {
  JOB_STATUS_CANCELLED,
  JOB_STATUS_COMPLETED,
  JOB_STATUS_FAILED,
  type JobStatus,
  STEP_STATUS_CANCELLED,
  STEP_STATUS_COMPLETED,
  STEP_STATUS_FAILED,
  type StepStatus,
} from '../constants.js'
import type {
  CancelJobOptions,
  CancelJobStepOptions,
  CompleteJobOptions,
  CompleteJobStepOptions,
  CreateJobOptions,
  CreateOrRecoverJobStepOptions,
  CreateOrRecoverJobStepResult,
  DelayJobStepOptions,
  DeleteJobOptions,
  DeleteJobsOptions,
  FailJobOptions,
  FailJobStepOptions,
  FetchOptions,
  GetActionsResult,
  GetJobStepsOptions,
  GetJobStepsResult,
  GetJobsOptions,
  GetJobsResult,
  Job,
  JobStatusResult,
  JobStep,
  JobStepStatusResult,
  RecoverJobsOptions,
  RetryJobOptions,
} from './schemas.js'
import {
  BooleanResultSchema,
  CancelJobOptionsSchema,
  CancelJobStepOptionsSchema,
  CompleteJobOptionsSchema,
  CompleteJobStepOptionsSchema,
  CreateJobOptionsSchema,
  CreateOrRecoverJobStepOptionsSchema,
  CreateOrRecoverJobStepResultNullableSchema,
  DelayJobStepOptionsSchema,
  DeleteJobOptionsSchema,
  DeleteJobsOptionsSchema,
  FailJobOptionsSchema,
  FailJobStepOptionsSchema,
  FetchOptionsSchema,
  GetActionsResultSchema,
  GetJobStepsOptionsSchema,
  GetJobStepsResultSchema,
  GetJobsOptionsSchema,
  GetJobsResultSchema,
  JobIdResultSchema,
  JobSchema,
  JobStatusResultSchema,
  JobStepSchema,
  JobStepStatusResultSchema,
  JobsArrayResultSchema,
  NumberResultSchema,
  RecoverJobsOptionsSchema,
  RetryJobOptionsSchema,
} from './schemas.js'

// Re-export types from schemas for backward compatibility
export type {
  ActionStats,
  CancelJobOptions,
  CancelJobStepOptions,
  CompleteJobOptions,
  CompleteJobStepOptions,
  CreateJobOptions,
  CreateOrRecoverJobStepOptions,
  CreateOrRecoverJobStepResult,
  DelayJobStepOptions,
  DeleteJobOptions,
  DeleteJobsOptions,
  FailJobOptions,
  FailJobStepOptions,
  FetchOptions,
  GetActionsResult,
  GetJobStepsOptions,
  GetJobStepsResult,
  GetJobsOptions,
  GetJobsResult,
  Job,
  JobFilters,
  JobSort,
  JobSortField,
  JobStatusResult,
  JobStep,
  JobStepStatusResult,
  RecoverJobsOptions,
  RetryJobOptions,
  SortOrder,
} from './schemas.js'

// ============================================================================
// Adapter Events
// ============================================================================

export interface AdapterEvents {
  'job-status-changed': [
    {
      jobId: string
      status: JobStatus | 'retried'
      clientId: string
    },
  ]
  'job-available': [
    {
      jobId: string
    },
  ]
  'step-status-changed': [
    {
      jobId: string
      stepId: string
      status: StepStatus
      error: any | null
      clientId: string
    },
  ]
  'step-delayed': [
    {
      jobId: string
      stepId: string
      delayedMs: number
      error: any
      clientId: string
    },
  ]
}

// ============================================================================
// Abstract Adapter Class
// ============================================================================

/**
 * Abstract base class for database adapters.
 * All adapters must extend this class and implement its abstract methods.
 */
export abstract class Adapter extends EventEmitter<AdapterEvents> {
  #id!: string
  #started: boolean = false
  #stopped: boolean = false
  #starting: Promise<boolean> | null = null
  #stopping: Promise<boolean> | null = null
  #logger: Logger | null = null

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Start the adapter.
   * Performs any necessary initialization, such as running migrations or setting up listeners.
   *
   * @returns Promise resolving to `true` if started successfully, `false` otherwise
   */
  async start() {
    try {
      if (!this.#id) {
        throw new Error('Adapter ID is not set')
      }

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
        await this._start()
        this.#started = true
        this.#starting = null
        return true
      })()

      return this.#starting
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.start()')
      throw error
    }
  }

  /**
   * Stop the adapter.
   * Performs cleanup, such as closing database connections.
   *
   * @returns Promise resolving to `true` if stopped successfully, `false` otherwise
   */
  async stop() {
    try {
      if (this.#stopped) {
        return true
      }

      if (this.#stopping) {
        return this.#stopping
      }

      this.#stopping = (async () => {
        await this._stop()
        this.#stopped = true
        this.#stopping = null
        return true
      })()

      return this.#stopping
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.stop()')
      throw error
    }
  }

  // ============================================================================
  // Configuration Methods
  // ============================================================================

  /**
   * Set the unique identifier for this adapter instance.
   * Used for multi-process coordination and job ownership.
   *
   * @param id - The unique identifier for this adapter instance
   */
  setId(id: string) {
    try {
      this.#id = id
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.setId()')
      throw error
    }
  }

  /**
   * Set the logger instance for this adapter.
   *
   * @param logger - The logger instance to use for logging
   */
  setLogger(logger: Logger) {
    try {
      this.#logger = logger
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.setLogger()')
      throw error
    }
  }

  /**
   * Get the unique identifier for this adapter instance.
   *
   * @returns The unique identifier for this adapter instance
   */
  get id(): string {
    return this.#id
  }

  /**
   * Get the logger instance for this adapter.
   *
   * @returns The logger instance, or `null` if not set
   */
  get logger(): Logger | null {
    return this.#logger
  }

  // ============================================================================
  // Job Methods
  // ============================================================================

  /**
   * Create a new job in the database.
   *
   * @returns Promise resolving to the job ID, or `null` if creation failed
   */
  async createJob(options: CreateJobOptions): Promise<string | null> {
    try {
      await this.start()
      const parsedOptions = CreateJobOptionsSchema.parse(options)
      const result = await this._createJob(parsedOptions)
      const jobId = JobIdResultSchema.parse(result)
      if (jobId !== null) {
        await this._notify('job-available', { jobId })
      }
      return jobId
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.createJob()')
      throw error
    }
  }

  /**
   * Mark a job as completed.
   *
   * @returns Promise resolving to `true` if completed, `false` otherwise
   */
  async completeJob(options: CompleteJobOptions): Promise<boolean> {
    try {
      await this.start()
      const parsedOptions = CompleteJobOptionsSchema.parse(options)
      const result = await this._completeJob(parsedOptions)
      const success = BooleanResultSchema.parse(result)
      if (success) {
        await this._notify('job-status-changed', {
          jobId: parsedOptions.jobId,
          status: JOB_STATUS_COMPLETED,
          clientId: this.id,
        })
      }
      return success
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.completeJob()')
      throw error
    }
  }

  /**
   * Mark a job as failed.
   *
   * @returns Promise resolving to `true` if failed, `false` otherwise
   */
  async failJob(options: FailJobOptions): Promise<boolean> {
    try {
      await this.start()
      const parsedOptions = FailJobOptionsSchema.parse(options)
      const result = await this._failJob(parsedOptions)
      const success = BooleanResultSchema.parse(result)
      if (success) {
        await this._notify('job-status-changed', {
          jobId: parsedOptions.jobId,
          status: JOB_STATUS_FAILED,
          clientId: this.id,
        })
      }
      return success
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.failJob()')
      throw error
    }
  }

  /**
   * Cancel a job.
   *
   * @returns Promise resolving to `true` if cancelled, `false` otherwise
   */
  async cancelJob(options: CancelJobOptions): Promise<boolean> {
    try {
      await this.start()
      const parsedOptions = CancelJobOptionsSchema.parse(options)
      const result = await this._cancelJob(parsedOptions)
      const success = BooleanResultSchema.parse(result)
      if (success) {
        await this._notify('job-status-changed', {
          jobId: parsedOptions.jobId,
          status: JOB_STATUS_CANCELLED,
          clientId: this.id,
        })
      }
      return success
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.cancelJob()')
      throw error
    }
  }

  /**
   * Retry a failed job by creating a copy of it with status 'created' and cleared output/error.
   *
   * @returns Promise resolving to the job ID, or `null` if creation failed
   */
  async retryJob(options: RetryJobOptions): Promise<string | null> {
    try {
      await this.start()
      const parsedOptions = RetryJobOptionsSchema.parse(options)
      const result = await this._retryJob(parsedOptions)
      const jobId = JobIdResultSchema.parse(result)
      if (jobId !== null) {
        await this._notify('job-available', { jobId })
      }
      return jobId
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.retryJob()')
      throw error
    }
  }

  /**
   * Delete a job by its ID.
   * Active jobs cannot be deleted.
   *
   * @returns Promise resolving to `true` if deleted, `false` otherwise
   */
  async deleteJob(options: DeleteJobOptions): Promise<boolean> {
    try {
      await this.start()
      const parsedOptions = DeleteJobOptionsSchema.parse(options)
      const result = await this._deleteJob(parsedOptions)
      return BooleanResultSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.deleteJob()')
      throw error
    }
  }

  /**
   * Delete multiple jobs using the same filters as getJobs.
   * Active jobs cannot be deleted and will be excluded from deletion.
   *
   * @returns Promise resolving to the number of jobs deleted
   */
  async deleteJobs(options?: DeleteJobsOptions): Promise<number> {
    try {
      await this.start()
      const parsedOptions = options ? DeleteJobsOptionsSchema.parse(options) : undefined
      const result = await this._deleteJobs(parsedOptions)
      return NumberResultSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.deleteJobs()')
      throw error
    }
  }

  /**
   * Fetch jobs from the database respecting concurrency limits per group.
   *
   * @returns Promise resolving to an array of fetched jobs
   */
  async fetch(options: FetchOptions): Promise<Job[]> {
    try {
      await this.start()
      const parsedOptions = FetchOptionsSchema.parse(options)
      const result = await this._fetch(parsedOptions)
      return JobsArrayResultSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.fetch()')
      throw error
    }
  }

  /**
   * Recover stuck jobs (jobs that were active but the process that owned them is no longer running).
   *
   * @returns Promise resolving to the number of jobs recovered
   */
  async recoverJobs(options: RecoverJobsOptions): Promise<number> {
    try {
      await this.start()
      const parsedOptions = RecoverJobsOptionsSchema.parse(options)
      const result = await this._recoverJobs(parsedOptions)
      return NumberResultSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.recoverJobs()')
      throw error
    }
  }

  // ============================================================================
  // Step Methods
  // ============================================================================

  /**
   * Create or recover a job step by creating or resetting a step record in the database.
   *
   * @returns Promise resolving to the step, or `null` if creation failed
   */
  async createOrRecoverJobStep(options: CreateOrRecoverJobStepOptions): Promise<CreateOrRecoverJobStepResult | null> {
    try {
      await this.start()
      const parsedOptions = CreateOrRecoverJobStepOptionsSchema.parse(options)
      const result = await this._createOrRecoverJobStep(parsedOptions)
      return CreateOrRecoverJobStepResultNullableSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.createOrRecoverJobStep()')
      throw error
    }
  }

  /**
   * Mark a job step as completed.
   *
   * @returns Promise resolving to `true` if completed, `false` otherwise
   */
  async completeJobStep(options: CompleteJobStepOptions): Promise<boolean> {
    try {
      await this.start()
      const parsedOptions = CompleteJobStepOptionsSchema.parse(options)
      const result = await this._completeJobStep(parsedOptions)
      const success = BooleanResultSchema.parse(result)
      if (success) {
        // Fetch jobId for notification
        const step = await this._getJobStepById(parsedOptions.stepId)
        if (step) {
          await this._notify('step-status-changed', {
            jobId: step.jobId,
            stepId: parsedOptions.stepId,
            status: STEP_STATUS_COMPLETED,
            error: null,
            clientId: this.id,
          })
        }
      }
      return success
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.completeJobStep()')
      throw error
    }
  }

  /**
   * Mark a job step as failed.
   *
   * @returns Promise resolving to `true` if failed, `false` otherwise
   */
  async failJobStep(options: FailJobStepOptions): Promise<boolean> {
    try {
      await this.start()
      const parsedOptions = FailJobStepOptionsSchema.parse(options)
      const result = await this._failJobStep(parsedOptions)
      const success = BooleanResultSchema.parse(result)
      if (success) {
        // Fetch jobId for notification
        const step = await this._getJobStepById(parsedOptions.stepId)
        if (step) {
          await this._notify('step-status-changed', {
            jobId: step.jobId,
            stepId: parsedOptions.stepId,
            status: STEP_STATUS_FAILED,
            error: parsedOptions.error,
            clientId: this.id,
          })
        }
      }
      return success
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.failJobStep()')
      throw error
    }
  }

  /**
   * Delay a job step.
   *
   * @returns Promise resolving to `true` if delayed, `false` otherwise
   */
  async delayJobStep(options: DelayJobStepOptions): Promise<boolean> {
    try {
      await this.start()
      const parsedOptions = DelayJobStepOptionsSchema.parse(options)
      const result = await this._delayJobStep(parsedOptions)
      const success = BooleanResultSchema.parse(result)
      if (success) {
        // Fetch jobId for notification
        const step = await this._getJobStepById(parsedOptions.stepId)
        if (step) {
          await this._notify('step-delayed', {
            jobId: step.jobId,
            stepId: parsedOptions.stepId,
            delayedMs: parsedOptions.delayMs,
            error: parsedOptions.error,
            clientId: this.id,
          })
        }
      }
      return success
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.delayJobStep()')
      throw error
    }
  }

  /**
   * Cancel a job step.
   *
   * @returns Promise resolving to `true` if cancelled, `false` otherwise
   */
  async cancelJobStep(options: CancelJobStepOptions): Promise<boolean> {
    try {
      await this.start()
      const parsedOptions = CancelJobStepOptionsSchema.parse(options)
      const result = await this._cancelJobStep(parsedOptions)
      const success = BooleanResultSchema.parse(result)
      if (success) {
        // Fetch jobId for notification
        const step = await this._getJobStepById(parsedOptions.stepId)
        if (step) {
          await this._notify('step-status-changed', {
            jobId: step.jobId,
            stepId: parsedOptions.stepId,
            status: STEP_STATUS_CANCELLED,
            error: null,
            clientId: this.id,
          })
        }
      }
      return success
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.cancelJobStep()')
      throw error
    }
  }

  // ============================================================================
  // Private Job Methods (to be implemented by adapters)
  // ============================================================================

  /**
   * Internal method to create a new job in the database.
   *
   * @param options - Validated job creation options
   * @returns Promise resolving to the job ID, or `null` if creation failed
   */
  protected abstract _createJob(options: CreateJobOptions): Promise<string | null>

  /**
   * Internal method to mark a job as completed.
   *
   * @param options - Validated job completion options
   * @returns Promise resolving to `true` if completed, `false` otherwise
   */
  protected abstract _completeJob(options: CompleteJobOptions): Promise<boolean>

  /**
   * Internal method to mark a job as failed.
   *
   * @param options - Validated job failure options
   * @returns Promise resolving to `true` if failed, `false` otherwise
   */
  protected abstract _failJob(options: FailJobOptions): Promise<boolean>

  /**
   * Internal method to cancel a job.
   *
   * @param options - Validated job cancellation options
   * @returns Promise resolving to `true` if cancelled, `false` otherwise
   */
  protected abstract _cancelJob(options: CancelJobOptions): Promise<boolean>

  /**
   * Internal method to retry a failed job by creating a copy of it with status 'created' and cleared output/error.
   *
   * @param options - Validated job retry options
   * @returns Promise resolving to the job ID, or `null` if creation failed
   */
  protected abstract _retryJob(options: RetryJobOptions): Promise<string | null>

  /**
   * Internal method to delete a job by its ID.
   * Active jobs cannot be deleted.
   *
   * @param options - Validated job deletion options
   * @returns Promise resolving to `true` if deleted, `false` otherwise
   */
  protected abstract _deleteJob(options: DeleteJobOptions): Promise<boolean>

  /**
   * Internal method to delete multiple jobs using the same filters as getJobs.
   * Active jobs cannot be deleted and will be excluded from deletion.
   *
   * @param options - Validated deletion options (same as GetJobsOptions)
   * @returns Promise resolving to the number of jobs deleted
   */
  protected abstract _deleteJobs(options?: DeleteJobsOptions): Promise<number>

  /**
   * Internal method to fetch jobs from the database respecting concurrency limits per group.
   *
   * @param options - Validated fetch options
   * @returns Promise resolving to an array of fetched jobs
   */
  protected abstract _fetch(options: FetchOptions): Promise<Job[]>

  /**
   * Internal method to recover stuck jobs (jobs that were active but the process that owned them is no longer running).
   *
   * @param options - Validated recovery options
   * @returns Promise resolving to the number of jobs recovered
   */
  protected abstract _recoverJobs(options: RecoverJobsOptions): Promise<number>

  // ============================================================================
  // Private Step Methods (to be implemented by adapters)
  // ============================================================================

  /**
   * Internal method to create or recover a job step by creating or resetting a step record in the database.
   *
   * @param options - Validated step creation options
   * @returns Promise resolving to the step, or `null` if creation failed
   */
  protected abstract _createOrRecoverJobStep(
    options: CreateOrRecoverJobStepOptions,
  ): Promise<CreateOrRecoverJobStepResult | null>

  /**
   * Internal method to mark a job step as completed.
   *
   * @param options - Validated step completion options
   * @returns Promise resolving to `true` if completed, `false` otherwise
   */
  protected abstract _completeJobStep(options: CompleteJobStepOptions): Promise<boolean>

  /**
   * Internal method to mark a job step as failed.
   *
   * @param options - Validated step failure options
   * @returns Promise resolving to `true` if failed, `false` otherwise
   */
  protected abstract _failJobStep(options: FailJobStepOptions): Promise<boolean>

  /**
   * Internal method to delay a job step.
   *
   * @param options - Validated step delay options
   * @returns Promise resolving to `true` if delayed, `false` otherwise
   */
  protected abstract _delayJobStep(options: DelayJobStepOptions): Promise<boolean>

  /**
   * Internal method to cancel a job step.
   *
   * @param options - Validated step cancellation options
   * @returns Promise resolving to `true` if cancelled, `false` otherwise
   */
  protected abstract _cancelJobStep(options: CancelJobStepOptions): Promise<boolean>

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
    try {
      const parsedJobId = z.string().parse(jobId)
      const result = await this._getJobById(parsedJobId)
      if (result === null) {
        return null
      }
      return JobSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.getJobById()')
      throw error
    }
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
    try {
      const parsedOptions = GetJobStepsOptionsSchema.parse(options)
      const result = await this._getJobSteps(parsedOptions)
      return GetJobStepsResultSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.getJobSteps()')
      throw error
    }
  }

  /**
   * Get jobs with pagination, filtering, and sorting.
   * Does not include step information or job output.
   *
   * @param options - Query options including pagination, filters, and sort
   * @returns Promise resolving to jobs result with pagination info
   */
  async getJobs(options?: GetJobsOptions): Promise<GetJobsResult> {
    try {
      const parsedOptions = options ? GetJobsOptionsSchema.parse(options) : undefined
      const result = await this._getJobs(parsedOptions)
      return GetJobsResultSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.getJobs()')
      throw error
    }
  }

  /**
   * Get a step by its ID with all information.
   *
   * @param stepId - The ID of the step to retrieve
   * @returns Promise resolving to the step, or `null` if not found
   */
  async getJobStepById(stepId: string): Promise<JobStep | null> {
    try {
      const parsedStepId = z.string().parse(stepId)
      const result = await this._getJobStepById(parsedStepId)
      if (result === null) {
        return null
      }
      return JobStepSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.getJobStepById()')
      throw error
    }
  }

  /**
   * Get job status and updatedAt timestamp.
   *
   * @param jobId - The ID of the job
   * @returns Promise resolving to job status result, or `null` if not found
   */
  async getJobStatus(jobId: string): Promise<JobStatusResult | null> {
    try {
      const parsedJobId = z.string().parse(jobId)
      const result = await this._getJobStatus(parsedJobId)
      if (result === null) {
        return null
      }
      return JobStatusResultSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.getJobStatus()')
      throw error
    }
  }

  /**
   * Get job step status and updatedAt timestamp.
   *
   * @param stepId - The ID of the step
   * @returns Promise resolving to step status result, or `null` if not found
   */
  async getJobStepStatus(stepId: string): Promise<JobStepStatusResult | null> {
    try {
      const parsedStepId = z.string().parse(stepId)
      const result = await this._getJobStepStatus(parsedStepId)
      if (result === null) {
        return null
      }
      return JobStepStatusResultSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.getJobStepStatus()')
      throw error
    }
  }

  /**
   * Get action statistics including counts and last job created date.
   *
   * @returns Promise resolving to action statistics
   */
  async getActions(): Promise<GetActionsResult> {
    try {
      const result = await this._getActions()
      return GetActionsResultSchema.parse(result)
    } catch (error) {
      this.#logger?.error(error, 'Error in Adapter.getActions()')
      throw error
    }
  }

  // ============================================================================
  // Private Query Methods (to be implemented by adapters)
  // ============================================================================

  /**
   * Internal method to get a job by its ID. Does not include step information.
   *
   * @param jobId - The validated ID of the job to retrieve
   * @returns Promise resolving to the job, or `null` if not found
   */
  protected abstract _getJobById(jobId: string): Promise<Job | null>

  /**
   * Internal method to get steps for a job with pagination and fuzzy search.
   * Steps are always ordered by created_at ASC.
   * Steps do not include output data.
   *
   * @param options - Validated query options including jobId, pagination, and search
   * @returns Promise resolving to steps result with pagination info
   */
  protected abstract _getJobSteps(options: GetJobStepsOptions): Promise<GetJobStepsResult>

  /**
   * Internal method to get jobs with pagination, filtering, and sorting.
   * Does not include step information or job output.
   *
   * @param options - Validated query options including pagination, filters, and sort
   * @returns Promise resolving to jobs result with pagination info
   */
  protected abstract _getJobs(options?: GetJobsOptions): Promise<GetJobsResult>

  /**
   * Internal method to get a step by its ID with all information.
   *
   * @param stepId - The validated ID of the step to retrieve
   * @returns Promise resolving to the step, or `null` if not found
   */
  protected abstract _getJobStepById(stepId: string): Promise<JobStep | null>

  /**
   * Internal method to get job status and updatedAt timestamp.
   *
   * @param jobId - The validated ID of the job
   * @returns Promise resolving to job status result, or `null` if not found
   */
  protected abstract _getJobStatus(jobId: string): Promise<JobStatusResult | null>

  /**
   * Internal method to get job step status and updatedAt timestamp.
   *
   * @param stepId - The validated ID of the step
   * @returns Promise resolving to step status result, or `null` if not found
   */
  protected abstract _getJobStepStatus(stepId: string): Promise<JobStepStatusResult | null>

  /**
   * Internal method to get action statistics including counts and last job created date.
   *
   * @returns Promise resolving to action statistics
   */
  protected abstract _getActions(): Promise<GetActionsResult>

  // ============================================================================
  // Protected Abstract Methods (to be implemented by adapters)
  // ============================================================================

  /**
   * Start the adapter.
   * Performs any necessary initialization, such as running migrations or setting up listeners.
   *
   * @returns Promise resolving to `void`
   */
  protected abstract _start(): Promise<void>

  /**
   * Stop the adapter.
   * Performs cleanup, such as closing database connections.
   *
   * @returns Promise resolving to `void`
   */
  protected abstract _stop(): Promise<void>

  /**
   * Send a notification event.
   * This is adapter-specific (e.g., PostgreSQL NOTIFY).
   *
   * @param event - The event name
   * @param data - The data to send
   * @returns Promise resolving to `void`
   */
  protected abstract _notify(event: string, data: any): Promise<void>
}
