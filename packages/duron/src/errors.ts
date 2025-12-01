/**
 * Base class for all built-in errors in Duron.
 * All errors include a cause property that can be serialized.
 */
export abstract class DuronError extends Error {
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
  // Constructor inherited from DuronError
}

/**
 * Error thrown when an action exceeds its timeout.
 */
export class ActionTimeoutError extends DuronError {
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
 * Checks if an error is a DuronError instance.
 */
export function isDuronError(error: unknown): error is DuronError {
  return error instanceof DuronError
}

/**
 * Checks if an error is a NonRetriableError instance.
 */
export function isNonRetriableError(error: unknown): error is NonRetriableError {
  return error instanceof NonRetriableError || error instanceof ActionCancelError || error instanceof ActionTimeoutError
}

/**
 * Checks if an error is a timeout error (ActionTimeoutError or StepTimeoutError).
 */
export function isTimeoutError(error: unknown): error is ActionTimeoutError | StepTimeoutError {
  return error instanceof ActionTimeoutError || error instanceof StepTimeoutError
}

/**
 * Checks if an error is a cancel error (ActionCancelError or StepCancelError).
 */
export function isCancelError(error: unknown): error is ActionCancelError {
  return error instanceof ActionCancelError
}

export type SerializableError = {
  name: string
  message: string
  cause?: unknown
  stack?: string
}

/**
 * Serializes an error for storage in the database.
 * Handles DuronError instances specially to preserve their type information.
 */
export function serializeError(error: unknown): {
  name: string
  message: string
  cause?: unknown
  stack?: string
} {
  if (error instanceof StepTimeoutError || error instanceof ActionTimeoutError) {
    return {
      name: error.name,
      message: error.message,
      cause: error.cause,
      stack: undefined,
    }
  }

  if (error instanceof DuronError) {
    return {
      name: error.name,
      message: error.message,
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
