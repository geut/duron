import type { Logger } from 'pino'
import * as z from 'zod'

import type { TelemetryContext } from './step-manager.js'
import generateChecksum from './utils/checksum.js'

export type RetryOptions = z.infer<typeof RetryOptionsSchema>

export type StepOptions = z.infer<typeof StepOptionsSchema>

export interface ActionHandlerContext<
  TInput extends z.ZodObject,
  TVariables = Record<string, unknown>,
> {
  input: z.infer<TInput>
  jobId: string
  groupKey: string
  var: TVariables
  logger: Logger

  /**
   * Telemetry context for recording metrics and span data.
   * Provides access to OpenTelemetry APIs for recording traces and metrics.
   */
  telemetry: TelemetryContext

  /**
   * Execute an inline step within the action.
   *
   * @param name - The name of the step (must be unique within the job)
   * @param cb - The step handler callback
   * @param options - Optional step configuration
   * @returns Promise resolving to the step result
   */
  step: <TResult>(
    name: string,
    cb: (ctx: StepHandlerContext) => Promise<TResult>,
    options?: z.input<typeof StepOptionsSchema>,
  ) => Promise<TResult>

  /**
   * Execute a reusable step definition created with createStep().
   *
   * @param stepDef - The step definition to execute
   * @param input - The input data for the step (validated against the step's input schema)
   * @param options - Optional step configuration overrides
   * @returns Promise resolving to the step result
   */
  run: <TStepInput extends z.ZodObject, TResult>(
    stepDef: StepDefinition<TStepInput, TResult, TVariables>,
    input: z.input<TStepInput>,
    options?: Partial<z.input<typeof StepOptionsSchema>>,
  ) => Promise<TResult>
}

export interface StepHandlerContext {
  /**
   * The abort signal for this step.
   * This signal will be aborted when:
   * - The action is cancelled
   * - The parent step times out
   * - This step times out
   */
  signal: AbortSignal

  /**
   * The unique ID of this step.
   */
  stepId: string

  /**
   * The ID of the parent step, or null if this is a root step.
   */
  parentStepId: string | null

  /**
   * Telemetry context for recording metrics and span data.
   * Provides access to OpenTelemetry APIs for recording traces and metrics.
   */
  telemetry: TelemetryContext

  /**
   * Create a nested child step.
   * Child steps inherit the abort signal chain from their parent.
   * All child steps MUST be awaited before the parent step returns.
   *
   * @param name - The name of the child step (must be unique within the job)
   * @param cb - The step handler callback
   * @param options - Optional step configuration
   * @returns Promise resolving to the step result
   */
  step: <TResult>(
    name: string,
    cb: (ctx: StepHandlerContext) => Promise<TResult>,
    options?: z.input<typeof StepOptionsSchema>,
  ) => Promise<TResult>

  /**
   * Execute a reusable step definition created with createStep().
   * Allows inline steps to call step definitions.
   *
   * @param stepDef - The step definition to execute
   * @param input - The input data for the step (validated against the step's input schema)
   * @param options - Optional step configuration overrides
   * @returns Promise resolving to the step result
   */
  run: <TStepInput extends z.ZodObject, TResult>(
    stepDef: StepDefinition<TStepInput, TResult, any>,
    input: z.input<TStepInput>,
    options?: Partial<z.input<typeof StepOptionsSchema>>,
  ) => Promise<TResult>
}

/**
 * Extended context for step definition handlers.
 * Includes all StepHandlerContext properties plus action-level context.
 */
export interface StepDefinitionHandlerContext<
  TInput extends z.ZodObject,
  TVariables = Record<string, unknown>,
> extends StepHandlerContext {
  /**
   * The validated input for this step.
   */
  input: z.infer<TInput>

  /**
   * Variables shared across the action.
   */
  var: TVariables

  /**
   * Logger instance for this step.
   */
  logger: Logger

  /**
   * The job ID this step belongs to.
   */
  jobId: string
}

/**
 * A reusable step definition created with createStep().
 * Can be executed within an action handler using ctx.run().
 */
export interface StepDefinition<
  TInput extends z.ZodObject,
  TResult,
  TVariables = Record<string, unknown>,
> {
  /**
   * The name of the step.
   * Can be a static string or a function that generates the name from the context.
   * The function receives a context object with input, variables, jobId, and parentStepId.
   *
   * @example
   * ```typescript
   * name: (ctx) => `process-user-${ctx.input.userId}`
   * ```
   *
   * @example
   * ```typescript
   * name: (ctx) => `step-${ctx.var.environment}-${ctx.jobId.slice(0, 8)}`
   * ```
   */
  name: string | ((ctx: StepNameContext<TInput, TVariables>) => string)

  /**
   * Zod schema for validating the step input.
   */
  input?: TInput

  /**
   * Retry configuration for this step.
   */
  retry?: z.input<typeof RetryOptionsSchema>

  /**
   * Timeout in milliseconds for this step.
   */
  expire?: number

  /**
   * Whether this step runs in parallel with siblings.
   */
  parallel?: boolean

  /**
   * The handler function that executes the step logic.
   */
  handler: (ctx: StepDefinitionHandlerContext<TInput, TVariables>) => Promise<TResult>

  /**
   * Internal marker to identify this as a step definition.
   * @internal
   */
  __stepDefinition: true
}

export interface ConcurrencyHandlerContext<
  TInput extends z.ZodObject,
  TVariables = Record<string, unknown>,
> {
  input: z.infer<TInput>
  var: TVariables
}

/**
 * Context available when generating dynamic step names.
 * Provides access to input, variables, job ID, and parent step ID.
 */
export interface StepNameContext<TInput extends z.ZodObject, TVariables = Record<string, unknown>> {
  /**
   * The validated input for this step.
   */
  input: z.infer<TInput>

  /**
   * Variables shared across the action.
   */
  var: TVariables

  /**
   * The job ID this step belongs to.
   */
  jobId: string

  /**
   * The ID of the parent step, or null if this is a root step.
   */
  parentStepId: string | null
}

/**
 * Retry configuration options for actions and steps.
 * Controls how failed operations are retried with exponential backoff.
 */
export interface RetryOptionsInput {
  /**
   * Maximum number of retry attempts.
   * Set to 0 to disable retries.
   *
   * @default 4
   */
  limit?: number

  /**
   * Exponential backoff factor.
   * The delay between retries is calculated as: `minTimeout * (factor ^ attemptNumber)`
   *
   * @default 2
   */
  factor?: number

  /**
   * Minimum delay in milliseconds before the first retry.
   * This is the base delay that gets multiplied by the factor.
   *
   * @default 1000
   */
  minTimeout?: number

  /**
   * Maximum delay in milliseconds between retries.
   * The calculated delay will be capped at this value to prevent
   * excessively long wait times.
   *
   * @default 30000
   */
  maxTimeout?: number
}

/**
 * Configuration options for steps within an action.
 * Controls concurrency, retries, and timeouts for step execution.
 */
export interface StepsConfigInput {
  /**
   * Maximum number of steps that can run concurrently within this action.
   * Higher values allow more parallelism but may increase resource usage.
   *
   * @default 100
   */
  concurrency?: number

  /**
   * Retry configuration for steps.
   * These settings apply to all steps unless overridden at the step level.
   *
   * @default { limit: 4, factor: 2, minTimeout: 1000, maxTimeout: 30000 }
   */
  retry?: RetryOptionsInput

  /**
   * Timeout in milliseconds for each step.
   * Steps that exceed this timeout will be cancelled and may be retried.
   *
   * @default 300000 (5 minutes)
   */
  expire?: number
}

/**
 * Group configuration for concurrency control.
 * Allows grouping jobs by key and controlling concurrency per group.
 */
export interface GroupsConfigInput<
  TInput extends z.ZodObject,
  TVariables = Record<string, unknown>,
> {
  /**
   * Function to determine the group key for a job.
   * Jobs with the same group key will respect the group concurrency limit.
   * Use this to limit concurrent processing of related jobs (e.g., per user, per tenant).
   *
   * If not provided, all jobs for this action will use the '@default' group key.
   *
   * @param ctx - Context containing the validated input and variables
   * @returns Promise resolving to the group key string
   *
   * @example
   * ```typescript
   * groupKey: async (ctx) => `user:${ctx.input.userId}`
   * ```
   */
  groupKey?: (ctx: ConcurrencyHandlerContext<TInput, TVariables>) => Promise<string>

  /**
   * Function to dynamically determine the concurrency limit for a job's group.
   * The concurrency limit is stored with each job and used during fetch operations.
   * This allows different groups to have different concurrency limits.
   *
   * If not provided, uses the global `groupConcurrencyLimit` from the client options.
   *
   * @param ctx - Context containing the validated input and variables
   * @returns Promise resolving to the concurrency limit number
   *
   * @example
   * ```typescript
   * concurrency: async (ctx) => ctx.input.priority === 'high' ? 10 : 2
   * ```
   */
  concurrency?: (ctx: ConcurrencyHandlerContext<TInput, TVariables>) => Promise<number>
}

/**
 * Definition for creating a Duron action.
 * Actions are type-safe, durable job handlers with built-in retry logic,
 * step-based execution, and concurrency control.
 *
 * @template TInput - Zod schema type for validating the action input
 * @template TOutput - Zod schema type for validating the action output
 * @template TVariables - Type of variables available to the action handler
 */
export interface ActionDefinitionInput<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
  TVariables = Record<string, unknown>,
> {
  /**
   * Unique name for this action.
   * Used as the queue name and must be unique across all actions registered with a client.
   * This name is used for job routing, logging, and dashboard display.
   *
   * @example 'send-email', 'process-payment', 'sync-user-data'
   */
  name: string

  /**
   * Optional version string for the action.
   * Used to track changes to the action and included in the checksum calculation.
   * Changing the version will cause existing jobs to be treated as having a different checksum.
   *
   * @example '1.0.0', '2024-01-15', 'v2'
   */
  version?: string

  /**
   * Zod schema for validating the action input.
   * If provided, input will be validated before the handler is called.
   * Invalid input will throw a validation error and the job will fail.
   *
   * @example
   * ```typescript
   * input: z.object({
   *   email: z.string().email(),
   *   subject: z.string().min(1),
   * })
   * ```
   */
  input?: TInput

  /**
   * Zod schema for validating the action output.
   * If provided, output will be validated after the handler completes.
   * Invalid output will cause the job to fail.
   *
   * @example
   * ```typescript
   * output: z.object({
   *   success: z.boolean(),
   *   messageId: z.string().optional(),
   * })
   * ```
   */
  output?: TOutput

  /**
   * Group configuration for concurrency control.
   * Allows grouping jobs by a dynamic key and controlling concurrency per group.
   * Useful for rate limiting per user, tenant, or resource.
   */
  groups?: GroupsConfigInput<TInput, TVariables>

  /**
   * Configuration for steps within this action.
   * Steps are retryable units of work that can be executed within the action handler.
   * These settings apply to all steps unless overridden at the step level.
   *
   * @default { concurrency: 100, retry: { limit: 4, factor: 2, minTimeout: 1000, maxTimeout: 30000 }, expire: 300000 }
   */
  steps?: StepsConfigInput

  /**
   * Maximum number of jobs for this action that can run concurrently across all workers.
   * This limit is enforced per action, regardless of group.
   *
   * @default 100
   */
  concurrency?: number

  /**
   * Timeout in milliseconds for the entire action.
   * Jobs that exceed this timeout will be cancelled.
   * Make sure this is greater than the expected total execution time including all steps.
   *
   * @default 900000 (15 minutes)
   */
  expire?: number

  /**
   * Function to generate a dynamic description for the job.
   * The description is calculated at job creation time and stored in the database.
   * Use this to provide context about what the specific job instance is doing.
   *
   * @param ctx - Context containing the validated input and variables
   * @returns Promise resolving to the description string
   *
   * @example
   * ```typescript
   * description: async (ctx) => `Send email to ${ctx.input.email}`
   * ```
   */
  description?: (ctx: ConcurrencyHandlerContext<TInput, TVariables>) => Promise<string>

  /**
   * The handler function that executes the action logic.
   * Receives a context object with validated input, variables, logger, and step functions.
   * Must return a Promise that resolves to the action output (matching the output schema if provided).
   *
   * @param ctx - Action handler context with input, variables, and step functions
   * @returns Promise resolving to the action output
   *
   * @example
   * ```typescript
   * handler: async (ctx) => {
   *   const result = await ctx.step('send', async () => {
   *     return await sendEmail(ctx.input.email, ctx.input.subject)
   *   })
   *   return { success: true, messageId: result.id }
   * }
   * ```
   */
  handler: (ctx: ActionHandlerContext<TInput, TVariables>) => Promise<z.infer<TOutput>>
}

// Type alias for backwards compatibility (inferred from Zod schema)
export type ActionDefinition<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
  TVariables = Record<string, unknown>,
> = ActionDefinitionInput<TInput, TOutput, TVariables>

// Compile-time check: ensure ActionDefinitionInput is assignable to the Zod schema's input type
type _EnsureActionDefinitionCompatible<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
  TVariables,
> =
  ActionDefinitionInput<TInput, TOutput, TVariables> extends z.input<
    ReturnType<typeof createActionDefinitionSchema<TInput, TOutput, TVariables>>
  >
    ? true
    : 'ERROR: ActionDefinitionInput does not match Zod schema input type'

// This will cause a compile error if the types diverge
declare const _actionDefCheck: _EnsureActionDefinitionCompatible<
  z.ZodObject<any>,
  z.ZodObject<any>,
  any
>
const _checkActionDef: _EnsureActionDefinitionCompatible<
  z.ZodObject<any>,
  z.ZodObject<any>,
  any
> = true

export type Action<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
  TVariables = Record<string, unknown>,
> = z.infer<ReturnType<typeof createActionDefinitionSchema<TInput, TOutput, TVariables>>>

export const RetryOptionsSchema = z
  .object({
    limit: z.number().default(4),
    factor: z.number().default(2),
    minTimeout: z.number().default(1000),
    maxTimeout: z.number().default(30000),
  })
  .default({ limit: 4, factor: 2, minTimeout: 1000, maxTimeout: 30000 })

export const StepOptionsSchema = z.object({
  retry: RetryOptionsSchema,
  expire: z.number().default(5 * 60 * 1000),
  parallel: z.boolean().default(false),
})

export function createActionDefinitionSchema<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
  TVariables = Record<string, unknown>,
>() {
  return z
    .object({
      name: z.string(),
      version: z.string().optional(),
      input: z
        .custom<TInput>((val: any) => {
          return !val || ('_zod' in val && 'type' in val && val.type === 'object')
        })
        .optional(),
      output: z
        .custom<TOutput>((val: any) => {
          return !val || ('_zod' in val && 'type' in val && val.type === 'object')
        })
        .optional(),
      groups: z
        .object({
          groupKey: z
            .custom<(ctx: ConcurrencyHandlerContext<TInput, TVariables>) => Promise<string>>(
              (val) => {
                return !val || typeof val === 'function'
              },
            )
            .optional(),
          concurrency: z
            .custom<(ctx: ConcurrencyHandlerContext<TInput, TVariables>) => Promise<number>>(
              (val) => {
                return !val || typeof val === 'function'
              },
            )
            .optional(),
        })
        .optional(),
      steps: z
        .object({
          concurrency: z.number().default(100),
          retry: RetryOptionsSchema,
          expire: z.number().default(5 * 60 * 1000),
        })
        .default({
          concurrency: 100,
          retry: { limit: 4, factor: 2, minTimeout: 1000, maxTimeout: 30000 },
          expire: 5 * 60 * 1000,
        }),
      concurrency: z.number().default(100),
      expire: z.number().default(15 * 60 * 1000),
      description: z
        .custom<(ctx: ConcurrencyHandlerContext<TInput, TVariables>) => Promise<string>>((val) => {
          return !val || typeof val === 'function'
        })
        .optional(),
      handler: z.custom<
        (ctx: ActionHandlerContext<TInput, TVariables>) => Promise<z.infer<TOutput>>
      >((val) => {
        return typeof val === 'function'
      }),
    })
    .transform((def) => {
      const checksum = [def.name, def.version, def.handler.toString()].filter(Boolean).join(':')
      return {
        ...def,
        checksum: generateChecksum(checksum),
      }
    })
}

export const defineAction = <TVariables = Record<string, unknown>>() => {
  return <TInput extends z.ZodObject, TOutput extends z.ZodObject>(
    def: ActionDefinition<TInput, TOutput, TVariables>,
  ) => {
    return createActionDefinitionSchema<TInput, TOutput, TVariables>().parse(def, {
      reportInput: true,
    })
  }
}

/**
 * Input type for createStep() - the definition object before transformation.
 */
export type StepDefinitionInput<
  TInput extends z.ZodObject,
  TResult,
  TVariables = Record<string, unknown>,
> = Omit<StepDefinition<TInput, TResult, TVariables>, '__stepDefinition'>

/**
 * Creates a reusable step definition that can be executed within action handlers.
 *
 * @template TVariables - Type of variables available to the step handler
 * @returns A curried function that accepts the step definition and returns a StepDefinition
 *
 * @example
 * ```typescript
 * const sendEmailStep = createStep<typeof variables>()({
 *   name: 'send-email',
 *   input: z.object({
 *     email: z.string().email(),
 *     body: z.string(),
 *   }),
 *   retry: { limit: 3 },
 *   expire: 60000,
 *   handler: async (ctx) => {
 *     // ctx.input is typed as { email: string, body: string }
 *     // ctx.var, ctx.logger, ctx.jobId are also available
 *     return { success: true }
 *   },
 * })
 *
 * // In an action handler:
 * const result = await ctx.run(sendEmailStep, { email: 'test@example.com', body: 'Hello' })
 * ```
 */
export const createStep = <TVariables = Record<string, unknown>>() => {
  return <TInput extends z.ZodObject, TResult>(
    def: StepDefinitionInput<TInput, TResult, TVariables>,
  ): StepDefinition<TInput, TResult, TVariables> => {
    return {
      ...def,
      __stepDefinition: true as const,
    }
  }
}
