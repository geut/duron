// ============================================================================
// Job Status Constants
// ============================================================================

export const JOB_STATUS_CREATED = 'created' as const
export const JOB_STATUS_ACTIVE = 'active' as const
export const JOB_STATUS_COMPLETED = 'completed' as const
export const JOB_STATUS_FAILED = 'failed' as const
export const JOB_STATUS_CANCELLED = 'cancelled' as const

export const JOB_STATUSES = [
  JOB_STATUS_CREATED,
  JOB_STATUS_ACTIVE,
  JOB_STATUS_COMPLETED,
  JOB_STATUS_FAILED,
  JOB_STATUS_CANCELLED,
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

// ============================================================================
// Step Status Constants
// ============================================================================

export const STEP_STATUS_ACTIVE = 'active' as const
export const STEP_STATUS_COMPLETED = 'completed' as const
export const STEP_STATUS_FAILED = 'failed' as const
export const STEP_STATUS_CANCELLED = 'cancelled' as const

export const STEP_STATUSES = [
  STEP_STATUS_ACTIVE,
  STEP_STATUS_COMPLETED,
  STEP_STATUS_FAILED,
  STEP_STATUS_CANCELLED,
] as const

export type StepStatus = (typeof STEP_STATUSES)[number]
