import type { Logger } from 'pino'
import * as z from 'zod'

import type { ObserveContext } from './telemetry/adapter.js'
import generateChecksum from './utils/checksum.js'

export type RetryOptions = z.infer<typeof RetryOptionsSchema>

export type StepOptions = z.infer<typeof StepOptionsSchema>

export interface ActionHandlerContext<TInput extends z.ZodObject, TVariables = Record<string, unknown>> {
  input: z.infer<TInput>
  jobId: string
  groupKey: string
  var: TVariables
  logger: Logger

  /**
   * Observability context for recording metrics and span data.
   * Allows recording custom metrics, span attributes, and events.
   */
  observe: ObserveContext

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
   * Observability context for recording metrics and span data.
   * Allows recording custom metrics, span attributes, and events.
   */
  observe: ObserveContext

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
export interface StepDefinitionHandlerContext<TInput extends z.ZodObject, TVariables = Record<string, unknown>>
  extends StepHandlerContext {
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
   * Can be a static string or a function that generates the name from the input.
   */
  name: string | ((ctx: { input: z.infer<TInput> }) => string)

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

export interface ConcurrencyHandlerContext<TInput extends z.ZodObject, TVariables = Record<string, unknown>> {
  input: z.infer<TInput>
  var: TVariables
}

export type ActionDefinition<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
  TVariables = Record<string, unknown>,
> = z.input<ReturnType<typeof createActionDefinitionSchema<TInput, TOutput, TVariables>>>

export type Action<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
  TVariables = Record<string, unknown>,
> = z.infer<ReturnType<typeof createActionDefinitionSchema<TInput, TOutput, TVariables>>>

/**
 * Retry configuration options for actions and steps.
 */
export const RetryOptionsSchema = z
  .object({
    /**
     * Maximum number of retry attempts.
     *
     * @default 4
     */
    limit: z.number().default(4),

    /**
     * Exponential backoff factor.
     * The delay between retries is calculated as: minTimeout * (factor ^ attemptNumber)
     *
     * @default 2
     */
    factor: z.number().default(2),

    /**
     * Minimum delay in milliseconds before the first retry.
     *
     * @default 1000
     */
    minTimeout: z.number().default(1000),

    /**
     * Maximum delay in milliseconds between retries.
     * The calculated delay will be capped at this value.
     *
     * @default 30000
     */
    maxTimeout: z.number().default(30000),
  })
  .default({ limit: 4, factor: 2, minTimeout: 1000, maxTimeout: 30000 })
  .describe('The retry options')

/**
 * Options for configuring a step within an action.
 */
export const StepOptionsSchema = z.object({
  /**
   * Retry configuration for this step.
   * If not provided, uses the default retry options from the action or Duron instance.
   */
  retry: RetryOptionsSchema,

  /**
   * Timeout in milliseconds for this step.
   * Steps that exceed this timeout will be cancelled.
   *
   * @default 300000 (5 minutes)
   */
  expire: z
    .number()
    .default(5 * 60 * 1000)
    .describe('The expire time for the step (milliseconds)'),

  /**
   * Whether this step runs in parallel with siblings.
   * Parallel steps are independent from siblings during time travel.
   * When time traveling to a step, completed parallel siblings are preserved.
   *
   * @default false
   */
  parallel: z.boolean().default(false).describe('Whether this step runs in parallel (independent from siblings)'),
})

/**
 * Creates a Zod schema for validating action definitions.
 *
 * @template TInput - Zod schema for the action input
 * @template TOutput - Zod schema for the action output
 * @template TVariables - Type of variables available to the action
 * @returns Zod schema for action definitions
 */
export function createActionDefinitionSchema<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
  TVariables = Record<string, unknown>,
>() {
  return z
    .object({
      /**
       * Unique name for this action.
       * Used as the queue name and must be unique across all actions.
       * Required.
       */
      name: z.string().describe('The name of the action'),

      /**
       * Version of the action.
       * Used to track changes to the action and generate the checksum.
       */
      version: z.string().describe('The version of the action').optional(),

      /**
       * Zod schema for validating the action input.
       * If provided, input will be validated before the handler is called.
       * If not provided, any input will be accepted.
       */
      input: z
        .custom<TInput>((val: any) => {
          return !val || ('_zod' in val && 'type' in val && val.type === 'object')
        })
        .optional(),

      /**
       * Zod schema for validating the action output.
       * If provided, output will be validated after the handler completes.
       * If not provided, any output will be accepted.
       */
      output: z
        .custom<TOutput>((val: any) => {
          return !val || ('_zod' in val && 'type' in val && val.type === 'object')
        })
        .optional(),

      groups: z
        .object({
          /**
           * Function to determine the group key for a job.
           * Jobs with the same group key will respect the group concurrency limit.
           * If not provided, all jobs for this action will use the '@default' group key.
           *
           * @param ctx - Context containing the input and variables
           * @returns Promise resolving to the group key string
           */
          groupKey: z
            .custom<(ctx: ConcurrencyHandlerContext<TInput, TVariables>) => Promise<string>>((val) => {
              return !val || val instanceof Function
            })
            .optional(),

          /**
           * Function to determine the concurrency limit for a job.
           * The concurrency limit is stored with each job and used during fetch operations.
           * When fetching jobs, the latest job's concurrency limit is used for each groupKey.
           * If not provided, defaults to 10.
           *
           * @param ctx - Context containing the input and variables
           * @returns Promise resolving to the concurrency limit number
           */
          concurrency: z
            .custom<(ctx: ConcurrencyHandlerContext<TInput, TVariables>) => Promise<number>>((val) => {
              return !val || val instanceof Function
            })
            .optional(),
        })
        .optional(),

      steps: z
        .object({
          /**
           * Function to determine the concurrency limit for a step.
           * The concurrency limit is stored with each step and used during fetch operations.
           * When fetching steps, the latest step's concurrency limit is used for each stepKey.
           * If not provided, defaults to 10.
           */
          concurrency: z.number().default(10).describe('How many steps can run concurrently for this action'),
          retry: RetryOptionsSchema.describe('How to retry on failure for the steps of this action'),
          expire: z
            .number()
            .default(5 * 60 * 1000)
            .describe('How long a step can run for (milliseconds)'),
        })
        .default({
          concurrency: 10,
          retry: { limit: 4, factor: 2, minTimeout: 1000, maxTimeout: 30000 },
          expire: 5 * 60 * 1000,
        }),

      concurrency: z.number().default(100).describe('How many jobs can run concurrently for this action'),

      expire: z
        .number()
        .default(15 * 60 * 1000)
        .describe('How long a job can run for (milliseconds)'),

      /**
       * The handler function that executes the action logic.
       * Receives a context object with input, variables, and a step function.
       * Must return a Promise that resolves to the action output.
       * Required.
       *
       * @param ctx - Action handler context
       * @returns Promise resolving to the action output
       */
      handler: z
        .custom<(ctx: ActionHandlerContext<TInput, TVariables>) => Promise<z.infer<TOutput>>>((val) => {
          return val instanceof Function
        })
        .describe('The handler for the action'),
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
