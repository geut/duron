import type { SerializableError } from 'duron/errors'

import type { JobStatus, StepStatus } from './api'

interface IsExpiringOptions {
  isStep: boolean
  expiresAt: Date
  status: JobStatus | StepStatus
  error: SerializableError | null
}

export function isExpiring({ isStep, expiresAt, status, error }: IsExpiringOptions) {
  if (status === 'completed') return false
  if (status === 'created') return false
  if (status === 'cancelled') return false
  if (status === 'failed') {
    if (isStep && error?.name === 'StepTimeoutError') return true
    if (!isStep && error?.name === 'ActionTimeoutError') return true
    return false
  }
  // is active and is expiring
  return expiresAt ? expiresAt < new Date() : false
}
