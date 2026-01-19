import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { createStep, defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_COMPLETED, JOB_STATUS_FAILED } from '../src/constants.js'
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
      hasObserve: typeof ctx.observe === 'object',
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
    hasObserve: z.boolean(),
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
        mixedStepsAction: typeof mixedStepsAction
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
            mixedStepsAction,
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
          hasObserve: boolean
          hasVar: boolean
          hasLogger: boolean
          hasJobId: boolean
          hasInput: boolean
          hasStepFunction: boolean
        }
        expect(output.hasSignal).toBe(true)
        expect(output.hasStepId).toBe(true)
        expect(output.hasParentStepId).toBe(true)
        expect(output.hasObserve).toBe(true)
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
  })
}

// Run tests with both adapters
runCreateStepTests(pgliteFactory)
runCreateStepTests(postgresFactory)
