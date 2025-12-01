import { z } from 'zod'

import { JOB_STATUSES, STEP_STATUSES } from '../constants.js'

// ============================================================================
// Status Enums
// ============================================================================

export const JobStatusSchema = z.enum(JOB_STATUSES)
export const StepStatusSchema = z.enum(STEP_STATUSES)

// ============================================================================
// Date Schema
// ============================================================================

const DateSchema = z.union([
  z.date(),
  z.string().transform((str) => new Date(str)),
  z.number().transform((num) => new Date(num)),
])

export const SerializableErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  cause: z.any().optional(),
  stack: z.string().optional(),
})

// ============================================================================
// Job Schema
// ============================================================================

export const JobSchema = z.object({
  id: z.string(),
  actionName: z.string(),
  groupKey: z.string(),
  input: z.any(),
  output: z.any().nullable(),
  error: z.any().nullable(),
  status: JobStatusSchema,
  timeoutMs: z.coerce.number(),
  expiresAt: DateSchema.nullable(),
  startedAt: DateSchema.nullable().default(null),
  finishedAt: DateSchema.nullable().default(null),
  createdAt: DateSchema,
  updatedAt: DateSchema,
  concurrencyLimit: z.coerce.number(),
})

// ============================================================================
// JobStep Schema
// ============================================================================

export const JobStepSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  name: z.string(),
  output: z.any().nullable().default(null),
  status: StepStatusSchema,
  error: z.any().nullable().default(null),
  startedAt: DateSchema,
  finishedAt: DateSchema.nullable().default(null),
  timeoutMs: z.coerce.number(),
  expiresAt: DateSchema.nullable().default(null),
  retriesLimit: z.coerce.number(),
  retriesCount: z.coerce.number(),
  delayedMs: z.coerce.number().nullable().default(null),
  historyFailedAttempts: z.record(
    z.string(),
    z.object({ failedAt: DateSchema, error: SerializableErrorSchema, delayedMs: z.coerce.number() }),
  ),
  createdAt: DateSchema,
  updatedAt: DateSchema,
})

// JobStep without output (for getJobSteps)
export const JobStepWithoutOutputSchema = JobStepSchema.omit({ output: true })

// ============================================================================
// Query Option Schemas
// ============================================================================

export const SortOrderSchema = z.enum(['asc', 'desc'])

export const JobSortFieldSchema = z.enum(['createdAt', 'startedAt', 'finishedAt', 'status', 'actionName', 'expiresAt'])

export const JobSortSchema = z.object({
  field: JobSortFieldSchema,
  order: SortOrderSchema,
})

export const JobFiltersSchema = z.object({
  status: z.union([JobStatusSchema, z.array(JobStatusSchema)]).optional(),
  actionName: z.union([z.string(), z.array(z.string())]).optional(),
  groupKey: z.union([z.string(), z.array(z.string())]).optional(),
  ownerId: z.union([z.string(), z.array(z.string())]).optional(),
  createdAt: z.union([DateSchema, z.array(DateSchema).length(2)]).optional(),
  startedAt: z.union([DateSchema, z.array(DateSchema).length(2)]).optional(),
  finishedAt: z.union([DateSchema, z.array(DateSchema).length(2)]).optional(),
  updatedAfter: DateSchema.optional(),
  inputFilter: z.record(z.string(), z.any()).optional(),
  outputFilter: z.record(z.string(), z.any()).optional(),
  search: z.string().optional(),
})

export const GetJobsOptionsSchema = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  filters: JobFiltersSchema.optional(),
  sort: z.union([JobSortSchema, z.array(JobSortSchema)]).optional(),
})

export const GetJobStepsOptionsSchema = z.object({
  jobId: z.string(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  search: z.string().optional(),
  updatedAfter: DateSchema.optional(),
})

// ============================================================================
// Job Option Schemas
// ============================================================================

export const CreateJobOptionsSchema = z.object({
  /** The queue name (action name) */
  queue: z.string(),
  /** The group key for concurrency control */
  groupKey: z.string(),
  /** The checksum of the action */
  checksum: z.string(),
  /** The job input data */
  input: z.any(),
  /** Timeout in milliseconds for the job */
  timeoutMs: z.number(),
  /** The concurrency limit for this job's group */
  concurrencyLimit: z.number(),
})

export const RecoverJobsOptionsSchema = z.object({
  /** The action checksums to recover jobs for */
  checksums: z.array(z.string()),
  /** Whether to ping other processes before recovering their jobs */
  multiProcessMode: z.boolean().optional(),
  /** Timeout in milliseconds to wait for process ping responses */
  processTimeout: z.number().optional(),
})

export const FetchOptionsSchema = z.object({
  /** Maximum number of jobs to fetch in this batch */
  batch: z.number(),
})

export const CompleteJobOptionsSchema = z.object({
  /** The ID of the job to complete */
  jobId: z.string(),
  /** The job output data */
  output: z.any(),
})

export const FailJobOptionsSchema = z.object({
  /** The ID of the job to fail */
  jobId: z.string(),
  /** The error data */
  error: z.any(),
})

export const CancelJobOptionsSchema = z.object({
  /** The ID of the job to cancel */
  jobId: z.string(),
})

export const RetryJobOptionsSchema = z.object({
  /** The ID of the job to retry */
  jobId: z.string(),
})

export const DeleteJobOptionsSchema = z.object({
  /** The ID of the job to delete */
  jobId: z.string(),
})

export const DeleteJobsOptionsSchema = GetJobsOptionsSchema.optional()

// ============================================================================
// Step Option Schemas
// ============================================================================

export const CreateOrRecoverJobStepOptionsSchema = z.object({
  /** The ID of the job this step belongs to */
  jobId: z.string(),
  /** The name of the step */
  name: z.string(),
  /** Timeout in milliseconds for the step */
  timeoutMs: z.number(),
  /** Maximum number of retries for the step */
  retriesLimit: z.number(),
})

export const CompleteJobStepOptionsSchema = z.object({
  /** The ID of the step to complete */
  stepId: z.string(),
  /** The step output data */
  output: z.any(),
})

export const FailJobStepOptionsSchema = z.object({
  /** The ID of the step to fail */
  stepId: z.string(),
  /** The error data */
  error: z.any(),
})

export const DelayJobStepOptionsSchema = z.object({
  /** The ID of the step to delay */
  stepId: z.string(),
  /** The delay in milliseconds */
  delayMs: z.number(),
  /** The error data */
  error: z.any(),
})

export const CancelJobStepOptionsSchema = z.object({
  /** The ID of the step to cancel */
  stepId: z.string(),
})

export const CreateOrRecoverJobStepResultSchema = z.object({
  id: z.string(),
  status: StepStatusSchema,
  retriesLimit: z.number(),
  retriesCount: z.number(),
  timeoutMs: z.number(),
  error: z.any().nullable(),
  output: z.any().nullable(),
  isNew: z.boolean(),
})

// ============================================================================
// Response Schemas
// ============================================================================

// Simple response schemas
export const JobIdResultSchema = z.union([z.string(), z.null()])
export const BooleanResultSchema = z.boolean()
export const NumberResultSchema = z.number()
export const JobsArrayResultSchema = z.array(JobSchema)
export const CreateOrRecoverJobStepResultNullableSchema = z.union([CreateOrRecoverJobStepResultSchema, z.null()])

export const GetJobsResultSchema = z.object({
  jobs: z.array(JobSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
})

export const GetJobStepsResultSchema = z.object({
  steps: z.array(JobStepWithoutOutputSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
})

export const ActionStatsSchema = z.object({
  name: z.string(),
  lastJobCreated: DateSchema.nullable(),
  active: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
})

export const GetActionsResultSchema = z.object({
  actions: z.array(ActionStatsSchema),
})

export const JobStatusResultSchema = z.object({
  status: JobStatusSchema,
  updatedAt: DateSchema,
})

export const JobStepStatusResultSchema = z.object({
  status: StepStatusSchema,
  updatedAt: DateSchema,
})

// ============================================================================
// Type Exports
// ============================================================================

export type Job = z.infer<typeof JobSchema>
export type JobStep = z.infer<typeof JobStepSchema>
export type JobStepWithoutOutput = z.infer<typeof JobStepWithoutOutputSchema>
export type SortOrder = z.infer<typeof SortOrderSchema>
export type JobSortField = z.infer<typeof JobSortFieldSchema>
export type JobSort = z.infer<typeof JobSortSchema>
export type JobFilters = z.infer<typeof JobFiltersSchema>
export type GetJobsOptions = z.infer<typeof GetJobsOptionsSchema>
export type GetJobStepsOptions = z.infer<typeof GetJobStepsOptionsSchema>
export type GetJobsResult = z.infer<typeof GetJobsResultSchema>
export type GetJobStepsResult = z.infer<typeof GetJobStepsResultSchema>
export type ActionStats = z.infer<typeof ActionStatsSchema>
export type GetActionsResult = z.infer<typeof GetActionsResultSchema>
export type JobStatusResult = z.infer<typeof JobStatusResultSchema>
export type JobStepStatusResult = z.infer<typeof JobStepStatusResultSchema>
export type CreateJobOptions = z.infer<typeof CreateJobOptionsSchema>
export type RecoverJobsOptions = z.infer<typeof RecoverJobsOptionsSchema>
export type FetchOptions = z.infer<typeof FetchOptionsSchema>
export type CompleteJobOptions = z.infer<typeof CompleteJobOptionsSchema>
export type FailJobOptions = z.infer<typeof FailJobOptionsSchema>
export type CancelJobOptions = z.infer<typeof CancelJobOptionsSchema>
export type RetryJobOptions = z.infer<typeof RetryJobOptionsSchema>
export type DeleteJobOptions = z.infer<typeof DeleteJobOptionsSchema>
export type DeleteJobsOptions = z.infer<typeof DeleteJobsOptionsSchema>
export type CreateOrRecoverJobStepOptions = z.infer<typeof CreateOrRecoverJobStepOptionsSchema>
export type CompleteJobStepOptions = z.infer<typeof CompleteJobStepOptionsSchema>
export type FailJobStepOptions = z.infer<typeof FailJobStepOptionsSchema>
export type DelayJobStepOptions = z.infer<typeof DelayJobStepOptionsSchema>
export type CancelJobStepOptions = z.infer<typeof CancelJobStepOptionsSchema>
export type CreateOrRecoverJobStepResult = z.infer<typeof CreateOrRecoverJobStepResultSchema>
