import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { createStep, defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_COMPLETED, JOB_STATUS_FAILED, STEP_STATUS_FAILED } from '../src/constants.js'

import { type Adapter, type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'
import { expectToBeDefined } from './asserts.js'

// =============================================================================
// Test Variables
// =============================================================================

const variables = {
  emailService: {
    send: async (email: string, body: string) => {
      return { sent: true, to: email, body }
    },
  },
  counter: 0,
}

// =============================================================================
// Test Step Definitions
// =============================================================================

/**
 * Basic step with static name
 */
const sendEmailStep = createStep<typeof variables>()({
  name: 'send-email',
  input: z.object({
    email: z.string().email(),
    body: z.string(),
  }),
  handler: async (ctx) => {
    const result = await ctx.var.emailService.send(ctx.input.email, ctx.input.body)
    return { success: result.sent, recipient: result.to }
  },
})

/**
 * Step with dynamic name for multiple calls
 */
const sendEmailDynamicStep = createStep<typeof variables>()({
  name: (ctx) => `send-email-${ctx.input.email}`,
  input: z.object({
    email: z.string().email(),
    body: z.string(),
  }),
  handler: async (ctx) => {
    const result = await ctx.var.emailService.send(ctx.input.email, ctx.input.body)
    return { success: result.sent, recipient: result.to }
  },
})

/**
 * Step with dynamic name based on input
 */
const processUserStep = createStep<typeof variables>()({
  name: (ctx) => `process-user-${ctx.input.userId}`,
  input: z.object({
    userId: z.string(),
    action: z.enum(['activate', 'deactivate']),
  }),
  handler: async (ctx) => {
    return {
      userId: ctx.input.userId,
      action: ctx.input.action,
      processed: true,
    }
  },
})

/**
 * Step with custom options
 */
const slowStepWithRetry = createStep<typeof variables>()({
  name: 'slow-step',
  input: z.object({
    delay: z.number(),
  }),
  retry: { limit: 2, minTimeout: 100, maxTimeout: 500, factor: 2 },
  expire: 10000,
  parallel: false,
  handler: async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, ctx.input.delay))
    return { delayed: ctx.input.delay }
  },
})

/**
 * Step that uses nested steps
 */
const parentWithNestedStep = createStep<typeof variables>()({
  name: 'parent-with-nested',
  input: z.object({
    count: z.number(),
  }),
  handler: async (ctx) => {
    const results: string[] = []

    // Use ctx.step for nested inline steps
    await ctx.step('nested-child', async () => {
      results.push('nested-child-executed')
      return { nested: true }
    })

    return { results, count: ctx.input.count }
  },
})

/**
 * Step that verifies context properties
 */
const contextVerificationStep = createStep<typeof variables>()({
  name: 'context-verification',
  input: z.object({
    testValue: z.string(),
  }),
  handler: async (ctx) => {
    return {
      hasSignal: ctx.signal instanceof AbortSignal,
      hasStepId: typeof ctx.stepId === 'string' && ctx.stepId.length > 0,
      hasParentStepId: ctx.parentStepId === null, // Root step has no parent
      hasTelemetry: typeof ctx.telemetry === 'object',
      hasVar: typeof ctx.var === 'object',
      hasLogger: typeof ctx.logger === 'object',
      hasJobId: typeof ctx.jobId === 'string' && ctx.jobId.length > 0,
      hasInput: ctx.input.testValue === 'test',
      hasStepFunction: typeof ctx.step === 'function',
    }
  },
})

/**
 * Step that fails
 */
const failingStep = createStep<typeof variables>()({
  name: 'failing-step',
  input: z.object({
    shouldFail: z.boolean(),
  }),
  retry: { limit: 0 }, // No retries
  handler: async (ctx) => {
    if (ctx.input.shouldFail) {
      throw new Error('Step failed intentionally')
    }
    return { success: true }
  },
})

/**
 * Step that always fails but retries before giving up
 */
const failingWithRetryStep = createStep<typeof variables>()({
  name: 'failing-with-retry-step',
  input: z.object({
    message: z.string(),
  }),
  retry: { limit: 3, minTimeout: 10, maxTimeout: 50, factor: 1 }, // 3 retries with minimal delays
  handler: async (ctx) => {
    // Increment counter to track how many times handler was called
    ctx.var.counter++
    throw new Error(`Step failed: ${ctx.input.message}`)
  },
})

/**
 * Inner step that can be called from another step definition
 */
const innerStep = createStep<typeof variables>()({
  name: (ctx) => `inner-step-${ctx.input.id}`,
  input: z.object({
    id: z.string(),
    value: z.number(),
  }),
  handler: async (ctx) => {
    return {
      innerId: ctx.input.id,
      doubledValue: ctx.input.value * 2,
    }
  },
})

/**
 * Outer step that calls inner step via ctx.run()
 */
const outerStep = createStep<typeof variables>()({
  name: 'outer-step',
  input: z.object({
    id: z.string(),
    value: z.number(),
  }),
  handler: async (ctx) => {
    // Call another step definition from within a step definition
    const innerResult = await ctx.run(innerStep, {
      id: ctx.input.id,
      value: ctx.input.value,
    })

    return {
      outerId: ctx.input.id,
      innerResult,
    }
  },
})

/**
 * Deeply nested step definitions (3 levels)
 */
const level3Step = createStep<typeof variables>()({
  name: (ctx) => `level3-${ctx.input.level}`,
  input: z.object({ level: z.number() }),
  handler: async (ctx) => {
    return { level: ctx.input.level, message: 'deepest' }
  },
})

const level2Step = createStep<typeof variables>()({
  name: (ctx) => `level2-${ctx.input.level}`,
  input: z.object({ level: z.number() }),
  handler: async (ctx) => {
    const level3Result = await ctx.run(level3Step, { level: ctx.input.level + 1 })
    return { level: ctx.input.level, nested: level3Result }
  },
})

const level1Step = createStep<typeof variables>()({
  name: (ctx) => `level1-${ctx.input.level}`,
  input: z.object({ level: z.number() }),
  handler: async (ctx) => {
    const level2Result = await ctx.run(level2Step, { level: ctx.input.level + 1 })
    return { level: ctx.input.level, nested: level2Result }
  },
})

// =============================================================================
// Test Actions
// =============================================================================

const basicRunAction = defineAction<typeof variables>()({
  name: 'basic-run-action',
  version: '1.0.0',
  input: z.object({
    email: z.string().email(),
    body: z.string(),
  }),
  output: z.object({
    success: z.boolean(),
    recipient: z.string(),
  }),
  handler: async (ctx) => {
    return ctx.run(sendEmailStep, {
      email: ctx.input.email,
      body: ctx.input.body,
    })
  },
})

/**
 * Step with dynamic name using full context (input, var, jobId, parentStepId)
 */
const fullContextStep = createStep<typeof variables>()({
  name: (ctx) => `step-${ctx.input.userId}-${ctx.var.counter}-${ctx.jobId.slice(0, 8)}`,
  input: z.object({
    userId: z.string(),
  }),
  handler: async (ctx) => {
    return { userId: ctx.input.userId, processed: true }
  },
})

const dynamicNameAction = defineAction<typeof variables>()({
  name: 'dynamic-name-action',
  version: '1.0.0',
  input: z.object({
    userId: z.string(),
  }),
  output: z.object({
    userId: z.string(),
    action: z.string(),
    processed: z.boolean(),
  }),
  handler: async (ctx) => {
    return ctx.run(processUserStep, {
      userId: ctx.input.userId,
      action: 'activate',
    })
  },
})

/**
 * Action that uses step with full context for name generation
 */
const fullContextNameAction = defineAction<typeof variables>()({
  name: 'full-context-name-action',
  version: '1.0.0',
  input: z.object({
    userId: z.string(),
  }),
  output: z.object({
    userId: z.string(),
    processed: z.boolean(),
  }),
  handler: async (ctx) => {
    return ctx.run(fullContextStep, {
      userId: ctx.input.userId,
    })
  },
})

const optionsOverrideAction = defineAction<typeof variables>()({
  name: 'options-override-action',
  version: '1.0.0',
  input: z.object({
    delay: z.number(),
  }),
  output: z.object({
    delayed: z.number(),
  }),
  handler: async (ctx) => {
    // Override the expire option at call time
    return ctx.run(
      slowStepWithRetry,
      { delay: ctx.input.delay },
      { expire: 5000 }, // Override default 10000ms
    )
  },
})

const multipleStepsAction = defineAction<typeof variables>()({
  name: 'multiple-steps-action',
  version: '1.0.0',
  input: z.object({
    emails: z.array(z.string().email()),
    body: z.string(),
  }),
  output: z.object({
    results: z.array(
      z.object({
        success: z.boolean(),
        recipient: z.string(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const results = []
    for (const email of ctx.input.emails) {
      // Use dynamic name step to allow multiple calls with unique names
      const result = await ctx.run(sendEmailDynamicStep, { email, body: ctx.input.body })
      results.push(result)
    }
    return { results }
  },
})

const nestedStepDefAction = defineAction<typeof variables>()({
  name: 'nested-step-def-action',
  version: '1.0.0',
  input: z.object({
    count: z.number(),
  }),
  output: z.object({
    results: z.array(z.string()),
    count: z.number(),
  }),
  handler: async (ctx) => {
    return ctx.run(parentWithNestedStep, { count: ctx.input.count })
  },
})

const contextVerificationAction = defineAction<typeof variables>()({
  name: 'context-verification-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    hasSignal: z.boolean(),
    hasStepId: z.boolean(),
    hasParentStepId: z.boolean(),
    hasTelemetry: z.boolean(),
    hasVar: z.boolean(),
    hasLogger: z.boolean(),
    hasJobId: z.boolean(),
    hasInput: z.boolean(),
    hasStepFunction: z.boolean(),
  }),
  handler: async (ctx) => {
    return ctx.run(contextVerificationStep, { testValue: 'test' })
  },
})

const failingStepAction = defineAction<typeof variables>()({
  name: 'failing-step-action',
  version: '1.0.0',
  input: z.object({
    shouldFail: z.boolean(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  handler: async (ctx) => {
    return ctx.run(failingStep, { shouldFail: ctx.input.shouldFail })
  },
})

const failingWithRetryAction = defineAction<typeof variables>()({
  name: 'failing-with-retry-action',
  version: '1.0.0',
  input: z.object({
    message: z.string(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  handler: async (ctx) => {
    // Reset counter before test
    ctx.var.counter = 0
    return ctx.run(failingWithRetryStep, { message: ctx.input.message })
  },
})

const mixedStepsAction = defineAction<typeof variables>()({
  name: 'mixed-steps-action',
  version: '1.0.0',
  input: z.object({
    email: z.string().email(),
  }),
  output: z.object({
    inlineResult: z.string(),
    stepDefResult: z.object({
      success: z.boolean(),
      recipient: z.string(),
    }),
  }),
  handler: async (ctx) => {
    // Mix inline steps with step definitions
    const inlineResult = await ctx.step('inline-step', async () => {
      return 'inline-executed'
    })

    const stepDefResult = await ctx.run(sendEmailStep, {
      email: ctx.input.email,
      body: 'Test body',
    })

    return { inlineResult, stepDefResult }
  },
})

const nestedStepDefCallAction = defineAction<typeof variables>()({
  name: 'nested-step-def-call-action',
  version: '1.0.0',
  input: z.object({
    id: z.string(),
    value: z.number(),
  }),
  output: z.object({
    outerId: z.string(),
    innerResult: z.object({
      innerId: z.string(),
      doubledValue: z.number(),
    }),
  }),
  handler: async (ctx) => {
    // Call a step definition that calls another step definition
    return ctx.run(outerStep, {
      id: ctx.input.id,
      value: ctx.input.value,
    })
  },
})

const deeplyNestedStepDefAction = defineAction<typeof variables>()({
  name: 'deeply-nested-step-def-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    level: z.number(),
    nested: z.object({
      level: z.number(),
      nested: z.object({
        level: z.number(),
        message: z.string(),
      }),
    }),
  }),
  handler: async (ctx) => {
    // Call a step definition that calls another, which calls another (3 levels deep)
    return ctx.run(level1Step, { level: 1 })
  },
})

const inlineStepCallsRunAction = defineAction<typeof variables>()({
  name: 'inline-step-calls-run-action',
  version: '1.0.0',
  input: z.object({
    email: z.string().email(),
  }),
  output: z.object({
    inlineStepResult: z.object({
      stepDefResult: z.object({
        success: z.boolean(),
        recipient: z.string(),
      }),
    }),
  }),
  handler: async (ctx) => {
    // Use inline step that calls ctx.run() inside
    const inlineStepResult = await ctx.step('outer-inline-step', async (stepCtx) => {
      // Call a step definition from within an inline step
      const stepDefResult = await stepCtx.run(sendEmailStep, {
        email: ctx.input.email,
        body: 'Called from inline step',
      })
      return { stepDefResult }
    })

    return { inlineStepResult }
  },
})

/**
 * Step that has a generic name - used to test that same name works under different parents
 */
const commonNameStep = createStep<typeof variables>()({
  name: 'process', // Common name that could be used under different parents
  input: z.object({ value: z.string() }),
  handler: async (ctx) => {
    return { processed: ctx.input.value }
  },
})

const sameNameDifferentParentsAction = defineAction<typeof variables>()({
  name: 'same-name-different-parents-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    parent1Result: z.object({ processed: z.string() }),
    parent2Result: z.object({ processed: z.string() }),
  }),
  handler: async (ctx) => {
    // Two different parent inline steps, each calling a step with the same name
    const parent1Result = await ctx.step('parent-1', async (stepCtx) => {
      // This 'process' step has parent 'parent-1'
      return stepCtx.run(commonNameStep, { value: 'from-parent-1' })
    })

    const parent2Result = await ctx.step('parent-2', async (stepCtx) => {
      // This 'process' step has parent 'parent-2' - should work despite same name
      return stepCtx.run(commonNameStep, { value: 'from-parent-2' })
    })

    return { parent1Result, parent2Result }
  },
})

// =============================================================================
// Test Suite
// =============================================================================

function runCreateStepTests(adapterFactory: AdapterFactory) {
  describe(`createStep Tests with ${adapterFactory.name}`, () => {
    let client: Client<
      {
        basicRunAction: typeof basicRunAction
        dynamicNameAction: typeof dynamicNameAction
        optionsOverrideAction: typeof optionsOverrideAction
        multipleStepsAction: typeof multipleStepsAction
        nestedStepDefAction: typeof nestedStepDefAction
        contextVerificationAction: typeof contextVerificationAction
        failingStepAction: typeof failingStepAction
        failingWithRetryAction: typeof failingWithRetryAction
        mixedStepsAction: typeof mixedStepsAction
        nestedStepDefCallAction: typeof nestedStepDefCallAction
        deeplyNestedStepDefAction: typeof deeplyNestedStepDefAction
        inlineStepCallsRunAction: typeof inlineStepCallsRunAction
        sameNameDifferentParentsAction: typeof sameNameDifferentParentsAction
        fullContextNameAction: typeof fullContextNameAction
      },
      typeof variables
    >
    let database: Adapter
    let deleteDb: () => Promise<void>

    beforeEach(
      async () => {
        const adapterInstance = await adapterFactory.create({})
        database = adapterInstance.adapter
        deleteDb = adapterInstance.deleteDb

        client = new Client({
          database,
          actions: {
            basicRunAction,
            dynamicNameAction,
            optionsOverrideAction,
            multipleStepsAction,
            nestedStepDefAction,
            contextVerificationAction,
            failingStepAction,
            failingWithRetryAction,
            mixedStepsAction,
            nestedStepDefCallAction,
            deeplyNestedStepDefAction,
            inlineStepCallsRunAction,
            sameNameDifferentParentsAction,
            fullContextNameAction,
          },
          variables,
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
        })
      },
      { timeout: 60_000 },
    )

    afterEach(async () => {
      if (client) {
        await client.stop()
      }
      if (deleteDb) {
        await deleteDb()
      }
    })

    describe('Basic ctx.run()', () => {
      it('should execute a step definition with ctx.run()', async () => {
        const jobId = await client.runAction('basicRunAction', {
          email: 'test@example.com',
          body: 'Hello World',
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as { success: boolean; recipient: string }
        expect(output.success).toBe(true)
        expect(output.recipient).toBe('test@example.com')
      })

      it('should store step in database with correct name', async () => {
        const jobId = await client.runAction('basicRunAction', {
          email: 'test@example.com',
          body: 'Hello World',
        })
        await client.fetch({ batchSize: 10 })

        await client.waitForJob(jobId, { timeout: 5000 })

        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(1)
        expect(stepsResult.steps[0]!.name).toBe('send-email')
      })
    })

    describe('Dynamic Step Names', () => {
      it('should resolve dynamic step name from input', async () => {
        const jobId = await client.runAction('dynamicNameAction', {
          userId: 'user-123',
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(1)
        expect(stepsResult.steps[0]!.name).toBe('process-user-user-123')
      })

      it('should resolve dynamic step name using full context (input, var, jobId, parentStepId)', async () => {
        const jobId = await client.runAction('fullContextNameAction', {
          userId: 'user-456',
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(1)
        const stepName = stepsResult.steps[0]!.name
        // Should match pattern: step-{userId}-{counter}-{jobIdPrefix}
        expect(stepName).toMatch(/^step-user-456-0-[a-f0-9]{8}$/)
        expect(stepName).toContain('user-456')
        expect(stepName).toContain('0') // counter value
        expect(stepName).toContain(jobId.slice(0, 8)) // jobId prefix
      })
    })

    describe('Options Override', () => {
      it('should allow overriding step options at call time', async () => {
        const jobId = await client.runAction('optionsOverrideAction', {
          delay: 50,
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as { delayed: number }
        expect(output.delayed).toBe(50)
      })
    })

    describe('Multiple Steps', () => {
      it('should execute multiple step definitions in sequence', async () => {
        const jobId = await client.runAction('multipleStepsAction', {
          emails: ['a@example.com', 'b@example.com', 'c@example.com'],
          body: 'Hello',
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as { results: Array<{ success: boolean; recipient: string }> }
        expect(output.results.length).toBe(3)
        expect(output.results[0]!.recipient).toBe('a@example.com')
        expect(output.results[1]!.recipient).toBe('b@example.com')
        expect(output.results[2]!.recipient).toBe('c@example.com')
      })
    })

    describe('Nested Steps in Step Definitions', () => {
      it('should support nested inline steps within step definition handler', async () => {
        const jobId = await client.runAction('nestedStepDefAction', {
          count: 5,
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as { results: string[]; count: number }
        expect(output.results).toContain('nested-child-executed')
        expect(output.count).toBe(5)

        // Verify both steps exist in database
        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(2) // parent-with-nested + nested-child
      })
    })

    describe('Context Properties', () => {
      it('should provide all required context properties in step handler', async () => {
        const jobId = await client.runAction('contextVerificationAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as {
          hasSignal: boolean
          hasStepId: boolean
          hasParentStepId: boolean
          hasTelemetry: boolean
          hasVar: boolean
          hasLogger: boolean
          hasJobId: boolean
          hasInput: boolean
          hasStepFunction: boolean
        }
        expect(output.hasSignal).toBe(true)
        expect(output.hasStepId).toBe(true)
        expect(output.hasParentStepId).toBe(true)
        expect(output.hasTelemetry).toBe(true)
        expect(output.hasVar).toBe(true)
        expect(output.hasLogger).toBe(true)
        expect(output.hasJobId).toBe(true)
        expect(output.hasInput).toBe(true)
        expect(output.hasStepFunction).toBe(true)
      })
    })

    describe('Error Handling', () => {
      it('should propagate step errors correctly', async () => {
        const jobId = await client.runAction('failingStepAction', {
          shouldFail: true,
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_FAILED)
        expect(job.error).toBeDefined()
        expect(job.error.message).toContain('Step failed intentionally')
      })

      it('should complete successfully when step does not fail', async () => {
        const jobId = await client.runAction('failingStepAction', {
          shouldFail: false,
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)
      })

      it('should retry step definition before failing action', async () => {
        // Reset the counter
        variables.counter = 0

        const jobId = await client.runAction('failingWithRetryAction', {
          message: 'retry test',
        })

        // Process the job (may need multiple fetches for retries)
        for (let i = 0; i < 10; i++) {
          await client.fetch({ batchSize: 10 })
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        const job = await client.waitForJob(jobId, { timeout: 10000 })
        expectToBeDefined(job)

        // The action should have failed
        expect(job.status).toBe(JOB_STATUS_FAILED)
        expect(job.error).toBeDefined()
        expect(job.error.message).toContain('Step failed: retry test')

        // The step should have been called 4 times (1 initial + 3 retries)
        // Note: counter is reset in the action handler before calling run
        // But the step handler increments it each time
        expect(variables.counter).toBe(4)

        // Verify the step also failed
        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(1)
        const step = stepsResult.steps[0]!
        expect(step.name).toBe('failing-with-retry-step')
        expect(step.status).toBe(STEP_STATUS_FAILED)
        expect(step.retriesCount).toBe(3) // 3 retries after initial attempt
      })
    })

    describe('Mixed Steps', () => {
      it('should work with both inline steps and step definitions', async () => {
        const jobId = await client.runAction('mixedStepsAction', {
          email: 'mixed@example.com',
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as {
          inlineResult: string
          stepDefResult: { success: boolean; recipient: string }
        }
        expect(output.inlineResult).toBe('inline-executed')
        expect(output.stepDefResult.success).toBe(true)
        expect(output.stepDefResult.recipient).toBe('mixed@example.com')

        // Verify both steps exist
        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(2)
        const stepNames = stepsResult.steps.map((s) => s.name)
        expect(stepNames).toContain('inline-step')
        expect(stepNames).toContain('send-email')
      })
    })

    describe('Nested Step Definitions with ctx.run()', () => {
      it('should allow a step definition to call another step definition via ctx.run()', async () => {
        const jobId = await client.runAction('nestedStepDefCallAction', {
          id: 'test-123',
          value: 5,
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as {
          outerId: string
          innerResult: { innerId: string; doubledValue: number }
        }
        expect(output.outerId).toBe('test-123')
        expect(output.innerResult.innerId).toBe('test-123')
        expect(output.innerResult.doubledValue).toBe(10)

        // Verify both step definitions created steps
        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(2)
        const stepNames = stepsResult.steps.map((s) => s.name)
        expect(stepNames).toContain('outer-step')
        expect(stepNames).toContain('inner-step-test-123')
      })

      it('should support deeply nested step definitions (3 levels)', async () => {
        const jobId = await client.runAction('deeplyNestedStepDefAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as {
          level: number
          nested: {
            level: number
            nested: {
              level: number
              message: string
            }
          }
        }
        expect(output.level).toBe(1)
        expect(output.nested.level).toBe(2)
        expect(output.nested.nested.level).toBe(3)
        expect(output.nested.nested.message).toBe('deepest')

        // Verify all 3 step definitions created steps
        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(3)
        const stepNames = stepsResult.steps.map((s) => s.name)
        expect(stepNames).toContain('level1-1')
        expect(stepNames).toContain('level2-2')
        expect(stepNames).toContain('level3-3')
      })
    })

    describe('Inline Steps calling ctx.run()', () => {
      it('should allow inline steps to call step definitions via ctx.run()', async () => {
        const jobId = await client.runAction('inlineStepCallsRunAction', {
          email: 'inline-test@example.com',
        })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as {
          inlineStepResult: {
            stepDefResult: { success: boolean; recipient: string }
          }
        }
        expect(output.inlineStepResult.stepDefResult.success).toBe(true)
        expect(output.inlineStepResult.stepDefResult.recipient).toBe('inline-test@example.com')

        // Verify both the inline step and the step definition created steps
        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(2)
        const stepNames = stepsResult.steps.map((s) => s.name)
        expect(stepNames).toContain('outer-inline-step')
        expect(stepNames).toContain('send-email')
      })

      it('should set correct parent step ID when calling ctx.run() from inline step', async () => {
        const jobId = await client.runAction('inlineStepCallsRunAction', {
          email: 'parent-test@example.com',
        })
        await client.fetch({ batchSize: 10 })

        await client.waitForJob(jobId, { timeout: 5000 })

        // Get all steps and verify parent relationship
        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(2)

        // Find the outer inline step and the nested step definition step
        const foundOuterStep = stepsResult.steps.find((s) => s.name === 'outer-inline-step')
        const foundInnerStep = stepsResult.steps.find((s) => s.name === 'send-email')

        expectToBeDefined(foundOuterStep)
        expectToBeDefined(foundInnerStep)

        // The outer inline step should have no parent (root step)
        expect(foundOuterStep.parentStepId).toBeNull()

        // The step definition step should have the inline step as its parent
        expect(foundInnerStep.parentStepId).toBe(foundOuterStep.id)
      })
    })

    describe('Step Name Uniqueness with Parent Scope', () => {
      it('should allow same step name under different parent steps', async () => {
        const jobId = await client.runAction('sameNameDifferentParentsAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as {
          parent1Result: { processed: string }
          parent2Result: { processed: string }
        }
        expect(output.parent1Result.processed).toBe('from-parent-1')
        expect(output.parent2Result.processed).toBe('from-parent-2')

        // Verify all 4 steps exist (2 parents + 2 'process' steps)
        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(4)

        // Both 'process' steps should exist with different parents
        const processSteps = stepsResult.steps.filter((s) => s.name === 'process')
        expect(processSteps.length).toBe(2)

        // Verify they have different parents
        const parent1 = stepsResult.steps.find((s) => s.name === 'parent-1')
        const parent2 = stepsResult.steps.find((s) => s.name === 'parent-2')
        expectToBeDefined(parent1)
        expectToBeDefined(parent2)

        const process1 = processSteps.find((s) => s.parentStepId === parent1.id)
        const process2 = processSteps.find((s) => s.parentStepId === parent2.id)
        expectToBeDefined(process1)
        expectToBeDefined(process2)
      })
    })
  })
}

// Run tests with both adapters
runCreateStepTests(pgliteFactory)
// oxlint-disable-next-line useLiteralKeys
if (process.env['POSTGRES_TEST'] === 'true') {
  runCreateStepTests(postgresFactory)
}
