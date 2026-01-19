// Error codes for type checking without instanceof
export const ERROR_CODES = {
  DURON_ERROR: 'DURON_ERROR',
  STEP_ALREADY_EXECUTED: 'STEP_ALREADY_EXECUTED',
  NON_RETRIABLE: 'NON_RETRIABLE',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  STEP_TIMEOUT: 'STEP_TIMEOUT',
  ACTION_CANCEL: 'ACTION_CANCEL',
  UNHANDLED_CHILD_STEPS: 'UNHANDLED_CHILD_STEPS',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/**
 * Base class for all built-in errors in Duron.
 * All errors include a cause property that can be serialized.
 */
export abstract class DuronError extends Error {
  /**
   * Error code for type checking without instanceof.
   */
  public readonly code: ErrorCode = ERROR_CODES.DURON_ERROR

  /**
   * Whether this error should prevent retries.
   */
  public readonly nonRetriable: boolean = false

  /**
   * The underlying cause of the error, if any.
   *
   * This will be serialized and stored in the database.
   */
  public override readonly cause?: unknown

  constructor(
    message: string,
    options?: {
      /**
       * The underlying cause of the error, if any.
       *
       * This will be serialized and stored in the database.
       */
      cause?: unknown
    },
  ) {
    super(message)
    this.cause = options?.cause
    // Set the name to the class name
    this.name = this.constructor.name
    // Ensure stack trace points to the error location
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

/**
 * Error thrown when attempting to execute a step that has already been executed.
 */
export class StepAlreadyExecutedError extends DuronError {
  public override readonly code = ERROR_CODES.STEP_ALREADY_EXECUTED
  public override readonly nonRetriable = true

  /**
   * Create a new StepAlreadyExecutedError.
   *
   * @param stepName - The name of the step that was already executed
   * @param jobId - The ID of the job containing the step
   * @param actionName - The name of the action containing the step
   */
  constructor(stepName: string, jobId: string, actionName: string) {
    super(`Step "${stepName}" has already been executed for job "${jobId}" and action "${actionName}"`)
  }
}

/**
 * NonRetriableError indicates that a step should not be retried.
 *
 * If a step handler throws this error, the step will fail immediately
 * without retrying, even if retry options are configured.
 */
export class NonRetriableError extends DuronError {
  public override readonly code: ErrorCode = ERROR_CODES.NON_RETRIABLE
  public override readonly nonRetriable = true
}

/**
 * Error thrown when an action exceeds its timeout.
 */
export class ActionTimeoutError extends DuronError {
  public override readonly code = ERROR_CODES.ACTION_TIMEOUT
  public override readonly nonRetriable = true

  /**
   * Create a new ActionTimeoutError.
   *
   * @param actionName - The name of the action that timed out
   * @param timeoutMs - The timeout value in milliseconds
   * @param options - Optional error options including cause
   */
  constructor(
    actionName: string,
    timeoutMs: number,
    options?: {
      cause?: unknown
    },
  ) {
    super(`Action "${actionName}" timed out after ${timeoutMs}ms`, options)
  }
}

/**
 * Error thrown when a step exceeds its timeout.
 */
export class StepTimeoutError extends DuronError {
  public override readonly code = ERROR_CODES.STEP_TIMEOUT
  public override readonly nonRetriable = false

  /**
   * Create a new StepTimeoutError.
   *
   * @param stepName - The name of the step that timed out
   * @param jobId - The ID of the job containing the step
   * @param timeoutMs - The timeout value in milliseconds
   * @param options - Optional error options including cause
   */
  constructor(
    stepName: string,
    jobId: string,
    timeoutMs: number,
    options?: {
      cause?: unknown
    },
  ) {
    super(`Step "${stepName}" in job "${jobId}" timed out after ${timeoutMs}ms`, options)
  }
}

/**
 * Error thrown when an action is cancelled.
 */
export class ActionCancelError extends DuronError {
  public override readonly code = ERROR_CODES.ACTION_CANCEL
  public override readonly nonRetriable = true

  /**
   * Create a new ActionCancelError.
   *
   * @param actionName - The name of the action that was cancelled
   * @param jobId - The ID of the job containing the action
   * @param options - Optional error options including cause
   */
  constructor(
    actionName: string,
    jobId: string,
    options?: {
      cause?: unknown
    },
  ) {
    super(`Action "${actionName}" in job "${jobId}" was cancelled`, options)
  }
}

/**
 * Error thrown when a parent step completes with unhandled (non-awaited) child steps.
 *
 * This error indicates a bug in the action handler where child steps were started
 * but not properly awaited. All child steps must be awaited before the parent returns.
 */
export class UnhandledChildStepsError extends NonRetriableError {
  public override readonly code = ERROR_CODES.UNHANDLED_CHILD_STEPS

  /**
   * The name of the parent step that completed with unhandled children.
   */
  public readonly stepName: string

  /**
   * The number of unhandled child steps.
   */
  public readonly pendingCount: number

  /**
   * Create a new UnhandledChildStepsError.
   *
   * @param stepName - The name of the parent step
   * @param pendingCount - The number of unhandled child steps
   */
  constructor(stepName: string, pendingCount: number) {
    super(
      `Parent step "${stepName}" completed with ${pendingCount} unhandled child step(s). All child steps must be awaited before the parent returns.`,
    )
    this.stepName = stepName
    this.pendingCount = pendingCount
  }
}

/**
 * Checks if an error is a DuronError instance.
 */
export function isDuronError(error: unknown): error is DuronError {
  const code = (error as any)?.code
  return code !== undefined && Object.values(ERROR_CODES).includes(code)
}

/**
 * Checks if an error is a NonRetriableError instance.
 */
export function isNonRetriableError(error: unknown): error is NonRetriableError {
  return (error as any)?.nonRetriable === true
}

/**
 * Checks if an error is an UnhandledChildStepsError instance.
 */
export function isUnhandledChildStepsError(error: unknown): error is UnhandledChildStepsError {
  return (error as any)?.code === ERROR_CODES.UNHANDLED_CHILD_STEPS
}

/**
 * Checks if an error is a timeout error (ActionTimeoutError or StepTimeoutError).
 */
export function isTimeoutError(error: unknown): error is ActionTimeoutError | StepTimeoutError {
  const code = (error as any)?.code
  return code === ERROR_CODES.ACTION_TIMEOUT || code === ERROR_CODES.STEP_TIMEOUT
}

/**
 * Checks if an error is a cancel error (ActionCancelError or StepCancelError).
 */
export function isCancelError(error: unknown): error is ActionCancelError {
  return (error as any)?.code === ERROR_CODES.ACTION_CANCEL
}

export type SerializableError = {
  name: string
  message: string
  code?: ErrorCode
  nonRetriable?: boolean
  cause?: unknown
  stack?: string
}

/**
 * Serializes an error for storage in the database.
 * Handles DuronError instances specially to preserve their type information.
 */
export function serializeError(error: unknown): SerializableError {
  const code = (error as any)?.code
  const nonRetriable = (error as any)?.nonRetriable

  if (isTimeoutError(error)) {
    return {
      name: error.name,
      message: error.message,
      code,
      nonRetriable,
      cause: error.cause,
      stack: undefined,
    }
  }

  if (isDuronError(error)) {
    return {
      name: error.name,
      message: error.message,
      code,
      nonRetriable,
      cause: error.cause,
      stack: error.stack,
    }
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      cause: (error as any).cause,
      stack: error.stack,
    }
  }

  return {
    name: 'UnknownError',
    message: String(error),
  }
}
