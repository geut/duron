import * as z from 'zod/mini'

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
  z.pipe(z.string(), z.transform((str) => new Date(str))),
  z.pipe(z.number(), z.transform((num) => new Date(num))),
])

export const SerializableErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  cause: z.optional(z.any()),
  stack: z.optional(z.string()),
})

// ============================================================================
// Job Schema
// ============================================================================

export const JobSchema = z.object({
  id: z.string(),
  actionName: z.string(),
  groupKey: z.string(),
  description: z._default(z.nullable(z.string()), null),
  input: z.any(),
  output: z.nullable(z.any()),
  error: z.nullable(z.any()),
  status: JobStatusSchema,
  timeoutMs: z.coerce.number(),
  expiresAt: z.nullable(DateSchema),
  startedAt: z._default(z.nullable(DateSchema), null),
  finishedAt: z._default(z.nullable(DateSchema), null),
  createdAt: DateSchema,
  updatedAt: DateSchema,
  concurrencyLimit: z.coerce.number(),
  concurrencyStepLimit: z.coerce.number(),
  clientId: z.optional(z.nullable(z.string())),
  /** Duration in milliseconds (finishedAt - startedAt). Null if job hasn't finished. */
  durationMs: z._default(z.nullable(z.coerce.number()), null),
})

// ============================================================================
// JobStep Schema
// ============================================================================

export const JobStepSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  parentStepId: z._default(z.nullable(z.string()), null),
  parallel: z._default(z.boolean(), false),
  name: z.string(),
  output: z._default(z.nullable(z.any()), null),
  status: StepStatusSchema,
  error: z._default(z.nullable(z.any()), null),
  startedAt: DateSchema,
  finishedAt: z._default(z.nullable(DateSchema), null),
  timeoutMs: z.coerce.number(),
  expiresAt: z._default(z.nullable(DateSchema), null),
  retriesLimit: z.coerce.number(),
  retriesCount: z.coerce.number(),
  delayedMs: z._default(z.nullable(z.coerce.number()), null),
  historyFailedAttempts: z.record(
    z.string(),
    z.object({
      failedAt: DateSchema,
      error: SerializableErrorSchema,
      delayedMs: z.coerce.number(),
    }),
  ),
  createdAt: DateSchema,
  updatedAt: DateSchema,
})

// JobStep without output (for getJobSteps)
export const JobStepWithoutOutputSchema = z.omit(JobStepSchema, { output: true })

// ============================================================================
// Query Option Schemas
// ============================================================================

export const SortOrderSchema = z.enum(['asc', 'desc'])

export const JobSortFieldSchema = z.enum([
  'createdAt',
  'startedAt',
  'finishedAt',
  'status',
  'actionName',
  'expiresAt',
  'duration',
  'description',
])

export const JobSortSchema = z.object({
  field: JobSortFieldSchema,
  order: SortOrderSchema,
})

export const JobFiltersSchema = z.object({
  status: z.optional(z.union([JobStatusSchema, z.array(JobStatusSchema)])),
  actionName: z.optional(z.union([z.string(), z.array(z.string())])),
  groupKey: z.optional(z.union([z.string(), z.array(z.string())])),
  clientId: z.optional(z.union([z.string(), z.array(z.string())])),
  description: z.optional(z.string()),
  createdAt: z.optional(z.union([DateSchema, z.array(DateSchema).check(z.length(2))])),
  startedAt: z.optional(z.union([DateSchema, z.array(DateSchema).check(z.length(2))])),
  finishedAt: z.optional(z.union([DateSchema, z.array(DateSchema).check(z.length(2))])),
  updatedAfter: z.optional(DateSchema),
  inputFilter: z.optional(z.record(z.string(), z.any())),
  outputFilter: z.optional(z.record(z.string(), z.any())),
  search: z.optional(z.string()),
})

export const GetJobsOptionsSchema = z.object({
  page: z.optional(z.number().check(z.int(), z.positive())),
  pageSize: z.optional(z.number().check(z.int(), z.positive())),
  filters: z.optional(JobFiltersSchema),
  sort: z.optional(z.union([JobSortSchema, z.array(JobSortSchema)])),
})

export const GetJobStepsOptionsSchema = z.object({
  jobId: z.string(),
  search: z.optional(z.string()),
  updatedAfter: z.optional(DateSchema),
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
  /** The concurrency limit for steps within this job */
  concurrencyStepLimit: z.number(),
  /** Optional description for the job */
  description: z.optional(z.nullable(z.string())),
})

export const RecoverJobsOptionsSchema = z.object({
  /** The action checksums to recover jobs for */
  checksums: z.array(z.string()),
  /** Milliseconds after which a client without a heartbeat is considered dead */
  staleTimeoutMs: z.optional(z.number()),
  /** AbortSignal to cancel recovery (e.g., during shutdown) */
  signal: z.optional(z.instanceof(AbortSignal)),
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

export const DeleteJobsOptionsSchema = z.optional(GetJobsOptionsSchema)

export const TimeTravelJobOptionsSchema = z.object({
  /** The ID of the job to time travel */
  jobId: z.string(),
  /** The ID of the step to restart from */
  stepId: z.string(),
})

// ============================================================================
// Step Option Schemas
// ============================================================================

export const CreateOrRecoverJobStepOptionsSchema = z.object({
  /** The ID of the job this step belongs to */
  jobId: z.string(),
  /** The ID of the parent step (null for root steps) */
  parentStepId: z._default(z.nullable(z.string()), null),
  /** Whether this step runs in parallel (independent from siblings during time travel) */
  parallel: z._default(z.boolean(), false),
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
  error: z.nullable(z.any()),
  output: z.nullable(z.any()),
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
export const CreateOrRecoverJobStepResultNullableSchema = z.union([
  CreateOrRecoverJobStepResultSchema,
  z.null(),
])

export const GetJobsResultSchema = z.object({
  jobs: z.array(JobSchema),
  total: z.number().check(z.int(), z.nonnegative()),
  page: z.number().check(z.int(), z.positive()),
  pageSize: z.number().check(z.int(), z.positive()),
})

export const GetJobStepsResultSchema = z.object({
  steps: z.array(JobStepWithoutOutputSchema),
  total: z.number().check(z.int(), z.nonnegative()),
})

export const ActionStatsSchema = z.object({
  name: z.string(),
  lastJobCreated: z.nullable(DateSchema),
  active: z.number().check(z.int(), z.nonnegative()),
  completed: z.number().check(z.int(), z.nonnegative()),
  failed: z.number().check(z.int(), z.nonnegative()),
  cancelled: z.number().check(z.int(), z.nonnegative()),
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
// Archive Schemas
// ============================================================================

export const PruneArchiveOptionsSchema = z.object({
  olderThan: z.union([z.string(), z.date(), z.number()]),
  batchSize: z.optional(z.number()),
  maxBatches: z.optional(z.number()),
})

export const ArchiveStatsSchema = z.object({
  jobsCount: z.number(),
  stepsCount: z.number(),
  oldestJobDate: z.nullable(z.date()),
  totalSizeBytes: z.nullable(z.number()),
  lastPrunedAt: z.nullable(z.date()),
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
export type CreateOrRecoverJobStepOptions = z.input<typeof CreateOrRecoverJobStepOptionsSchema>
export type CompleteJobStepOptions = z.infer<typeof CompleteJobStepOptionsSchema>
export type FailJobStepOptions = z.infer<typeof FailJobStepOptionsSchema>
export type DelayJobStepOptions = z.infer<typeof DelayJobStepOptionsSchema>
export type CancelJobStepOptions = z.infer<typeof CancelJobStepOptionsSchema>
export type CreateOrRecoverJobStepResult = z.infer<typeof CreateOrRecoverJobStepResultSchema>
export type TimeTravelJobOptions = z.infer<typeof TimeTravelJobOptionsSchema>
export type PruneArchiveOptions = z.infer<typeof PruneArchiveOptionsSchema>
export type ArchiveStats = z.infer<typeof ArchiveStatsSchema>
