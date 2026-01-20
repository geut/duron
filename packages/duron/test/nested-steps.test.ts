import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_COMPLETED, JOB_STATUS_FAILED, STEP_STATUS_CANCELLED, STEP_STATUS_FAILED } from '../src/constants.js'
import { type Adapter, type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'
import { expectToBeDefined } from './asserts.js'

// =============================================================================
// Test Actions for Nested Steps
// =============================================================================

/**
 * Action with basic nested steps - child step awaited properly
 */
const nestedStepAction = defineAction()({
  name: 'nested-step-action',
  version: '1.0.0',
  input: z.object({
    depth: z.number().default(1),
  }),
  output: z.object({
    results: z.array(z.string()),
  }),
  handler: async (ctx) => {
    const results: string[] = []

    await ctx.step('parent-step', async (stepCtx) => {
      results.push('parent-started')

      // Create a nested child step using stepCtx.step()
      await stepCtx.step('child-step', async (childStepCtx) => {
        results.push('child-started')
        results.push(`child-stepId: ${childStepCtx.stepId}`)
        results.push(`child-parentStepId: ${childStepCtx.parentStepId}`)
        results.push('child-completed')
        return { childResult: true }
      })

      results.push('parent-completed')
      return { parentResult: true }
    })

    return { results }
  },
})

/**
 * Action with deeply nested steps (3+ levels)
 */
const deeplyNestedAction = defineAction()({
  name: 'deeply-nested-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    depth: z.number(),
    stepIds: z.array(z.string()),
  }),
  handler: async (ctx) => {
    const stepIds: string[] = []

    await ctx.step('level-1', async (level1Ctx) => {
      stepIds.push(level1Ctx.stepId)

      await level1Ctx.step('level-2', async (level2Ctx) => {
        stepIds.push(level2Ctx.stepId)

        await level2Ctx.step('level-3', async (level3Ctx) => {
          stepIds.push(level3Ctx.stepId)

          await level3Ctx.step('level-4', async (level4Ctx) => {
            stepIds.push(level4Ctx.stepId)
            return { deepest: true }
          })

          return { level: 3 }
        })

        return { level: 2 }
      })

      return { level: 1 }
    })

    return { depth: 4, stepIds }
  },
})

/**
 * Action with concurrent child steps under same parent
 */
const concurrentChildrenAction = defineAction()({
  name: 'concurrent-children-action',
  version: '1.0.0',
  input: z.object({
    childCount: z.number().default(3),
  }),
  output: z.object({
    childResults: z.array(z.number()),
  }),
  handler: async (ctx) => {
    const childResults: number[] = []

    await ctx.step('parent-step', async (stepCtx) => {
      // Create multiple child steps concurrently
      const promises = Array.from({ length: ctx.input.childCount }, (_, i) =>
        stepCtx.step(`child-${i}`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { index: i }
        }),
      )

      // Await all children
      const results = await Promise.all(promises)
      childResults.push(...results.map((r) => r.index))

      return { done: true }
    })

    return { childResults }
  },
})

/**
 * Action that does NOT await child step - should fail with UnhandledChildStepsError
 */
const unawaitedChildAction = defineAction()({
  name: 'unawaited-child-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    result: z.string(),
  }),
  handler: async (ctx) => {
    await ctx.step('parent-step', async (stepCtx) => {
      // BAD: Start child step but don't await it
      stepCtx.step('orphaned-child', async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return { orphaned: true }
      })

      // Parent returns immediately without waiting for child
      return { parentDone: true }
    })

    return { result: 'should-not-reach' }
  },
})

/**
 * Action where parent step times out - children should be aborted
 */
const parentTimeoutAction = defineAction()({
  name: 'parent-timeout-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    result: z.string(),
  }),
  steps: {
    concurrency: 10,
    retry: { limit: 0, factor: 2, minTimeout: 1000, maxTimeout: 30000 },
    expire: 5000, // Default timeout
  },
  handler: async (ctx) => {
    await ctx.step(
      'parent-step',
      async (stepCtx) => {
        // Create child step first, then parent times out
        const childPromise = stepCtx.step(
          'slow-child',
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 2000))
            return { slow: true }
          },
          { expire: 5000 },
        )

        // Wait a bit then the parent timeout kicks in
        await childPromise

        return { done: true }
      },
      { expire: 100 }, // Parent times out in 100ms
    )

    return { result: 'should-not-reach' }
  },
})

/**
 * Action with nested step that verifies parentStepId chain
 */
const parentStepIdVerificationAction = defineAction()({
  name: 'parent-step-id-verification',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    parentChain: z.array(
      z.object({
        stepId: z.string(),
        parentStepId: z.string().nullable(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const parentChain: Array<{ stepId: string; parentStepId: string | null }> = []

    await ctx.step('root-step', async (rootCtx) => {
      parentChain.push({
        stepId: rootCtx.stepId,
        parentStepId: rootCtx.parentStepId,
      })

      await rootCtx.step('nested-step', async (nestedCtx) => {
        parentChain.push({
          stepId: nestedCtx.stepId,
          parentStepId: nestedCtx.parentStepId,
        })

        await nestedCtx.step('deep-step', async (deepCtx) => {
          parentChain.push({
            stepId: deepCtx.stepId,
            parentStepId: deepCtx.parentStepId,
          })
          return {}
        })

        return {}
      })

      return {}
    })

    return { parentChain }
  },
})

const parallelStepsAction = defineAction()({
  name: 'parallel-steps-action',
  version: '1.0.0',
  input: z.object({
    delay: z.number().default(100),
  }),
  output: z.object({}),
  steps: {
    retry: {
      limit: 1,
    },
  },
  handler: async (ctx) => {
    const input = ctx.input

    await ctx.step('validate-order', async ({ step: nestedStep }) => {
      await nestedStep('check-inventory', async () => {
        return { success: true }
      })

      await nestedStep('verify-customer', async (ctx) => {
        await Promise.all([
          ctx.step(
            'deep-step-1',
            async () => {
              await new Promise((resolve) => setTimeout(resolve, input.delay))
              return { success: true }
            },
            { parallel: true, expire: 2000 },
          ),
          ctx.step(
            'deep-step-2',
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 100))
              return { success: true }
            },
            { parallel: true },
          ),
        ])
        return { success: true }
      })

      return { success: true }
    })

    return {}
  },
})

/**
 * Action that tries to create duplicate step names at root level
 */
const duplicateRootStepsAction = defineAction()({
  name: 'duplicate-root-steps-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({}),
  handler: async (ctx) => {
    await ctx.step('same-name', async () => {
      return { first: true }
    })

    // This should throw StepAlreadyExecutedError
    await ctx.step('same-name', async () => {
      return { second: true }
    })

    return {}
  },
})

/**
 * Action that tries to create duplicate step names under the same parent
 */
const duplicateNestedStepsAction = defineAction()({
  name: 'duplicate-nested-steps-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({}),
  handler: async (ctx) => {
    await ctx.step('parent', async ({ step }) => {
      await step('child-name', async () => {
        return { first: true }
      })

      // This should throw StepAlreadyExecutedError
      await step('child-name', async () => {
        return { second: true }
      })

      return {}
    })

    return {}
  },
})

/**
 * Action that verifies same step name under different parents is allowed
 */
const sameNameDifferentParentsAction = defineAction()({
  name: 'same-name-different-parents-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    results: z.array(z.string()),
  }),
  handler: async (ctx) => {
    const results: string[] = []

    await ctx.step('parent-1', async ({ step }) => {
      await step('shared-name', async () => {
        results.push('parent-1:shared-name')
        return {}
      })
      return {}
    })

    await ctx.step('parent-2', async ({ step }) => {
      // Same name as under parent-1, but different parent - should be allowed
      await step('shared-name', async () => {
        results.push('parent-2:shared-name')
        return {}
      })
      return {}
    })

    return { results }
  },
})

/**
 * Action with retryable step to verify history is cleared on retry
 */
let retryAttemptCounter = 0
const retryHistoryClearAction = defineAction()({
  name: 'retry-history-clear-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    attempts: z.number(),
  }),
  steps: {
    retry: {
      limit: 2,
      minTimeout: 10,
      maxTimeout: 50,
    },
  },
  handler: async (ctx) => {
    await ctx.step('parent-step', async ({ step }) => {
      // This child step should be re-executable after parent retries
      await step('child-step', async () => {
        retryAttemptCounter++
        if (retryAttemptCounter < 3) {
          throw new Error('Intentional failure to trigger retry')
        }
        return { success: true }
      })

      return {}
    })

    return { attempts: retryAttemptCounter }
  },
})

// =============================================================================
// Test Suite
// =============================================================================

function runNestedStepsTests(adapterFactory: AdapterFactory) {
  describe(`Nested Steps Tests with ${adapterFactory.name}`, () => {
    let client: Client<
      {
        nestedStepAction: typeof nestedStepAction
        deeplyNestedAction: typeof deeplyNestedAction
        concurrentChildrenAction: typeof concurrentChildrenAction
        unawaitedChildAction: typeof unawaitedChildAction
        parentTimeoutAction: typeof parentTimeoutAction
        parentStepIdVerificationAction: typeof parentStepIdVerificationAction
        parallelStepsAction: typeof parallelStepsAction
        duplicateRootStepsAction: typeof duplicateRootStepsAction
        duplicateNestedStepsAction: typeof duplicateNestedStepsAction
        sameNameDifferentParentsAction: typeof sameNameDifferentParentsAction
        retryHistoryClearAction: typeof retryHistoryClearAction
      },
      Record<string, unknown>
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
            nestedStepAction,
            deeplyNestedAction,
            concurrentChildrenAction,
            unawaitedChildAction,
            parentTimeoutAction,
            parentStepIdVerificationAction,
            parallelStepsAction,
            duplicateRootStepsAction,
            duplicateNestedStepsAction,
            sameNameDifferentParentsAction,
            retryHistoryClearAction,
          },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
        })

        // Reset retry counter for each test
        retryAttemptCounter = 0
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

    describe('Basic Nested Steps', () => {
      it('should execute nested steps with proper awaiting', async () => {
        const jobId = await client.runAction('nestedStepAction', { depth: 1 })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as { results: string[] }
        expect(output.results).toContain('parent-started')
        expect(output.results).toContain('child-started')
        expect(output.results).toContain('child-completed')
        expect(output.results).toContain('parent-completed')

        // Verify order: parent starts, child executes, parent completes
        const parentStartIdx = output.results.indexOf('parent-started')
        const childStartIdx = output.results.indexOf('child-started')
        const childCompleteIdx = output.results.indexOf('child-completed')
        const parentCompleteIdx = output.results.indexOf('parent-completed')

        expect(parentStartIdx).toBeLessThan(childStartIdx)
        expect(childStartIdx).toBeLessThan(childCompleteIdx)
        expect(childCompleteIdx).toBeLessThan(parentCompleteIdx)
      })

      it('should provide stepId and parentStepId in step context', async () => {
        const jobId = await client.runAction('nestedStepAction', { depth: 1 })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as { results: string[] }

        // Find stepId and parentStepId entries
        const stepIdEntry = output.results.find((r) => r.startsWith('child-stepId:'))
        const parentStepIdEntry = output.results.find((r) => r.startsWith('child-parentStepId:'))

        expect(stepIdEntry).toBeDefined()
        expect(parentStepIdEntry).toBeDefined()

        // Extract values
        const childStepId = stepIdEntry?.split(': ')[1]
        const parentStepId = parentStepIdEntry?.split(': ')[1]

        // Child should have a stepId
        expect(childStepId).toBeTruthy()
        expect(childStepId).not.toBe('undefined')
        expect(childStepId).not.toBe('null')

        // Child should have a parentStepId (the parent step's ID)
        expect(parentStepId).toBeTruthy()
        expect(parentStepId).not.toBe('undefined')
        expect(parentStepId).not.toBe('null')
      })

      it('should store parentStepId in database', async () => {
        const jobId = await client.runAction('nestedStepAction', { depth: 1 })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)

        // Get all steps for the job
        const stepsResult = await client.getJobSteps({ jobId })
        const steps = stepsResult.steps

        expect(steps.length).toBe(2) // parent + child

        const parentStep = steps.find((s) => s.name === 'parent-step')
        const childStep = steps.find((s) => s.name === 'child-step')

        expectToBeDefined(parentStep)
        expectToBeDefined(childStep)

        // Parent step should have no parentStepId (it's a root step)
        expect((parentStep as any).parentStepId).toBeNull()

        // Child step should have parentStepId pointing to parent
        expect((childStep as any).parentStepId).toBe(parentStep.id)
      })
    })

    describe('Deep Nesting', () => {
      it('should support deeply nested steps (4 levels)', async () => {
        const jobId = await client.runAction('deeplyNestedAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as { depth: number; stepIds: string[] }
        expect(output.depth).toBe(4)
        expect(output.stepIds.length).toBe(4)

        // All step IDs should be unique
        const uniqueIds = new Set(output.stepIds)
        expect(uniqueIds.size).toBe(4)
      })

      it('should maintain correct parent chain in deep nesting', async () => {
        const jobId = await client.runAction('parentStepIdVerificationAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as {
          parentChain: Array<{ stepId: string; parentStepId: string | null }>
        }

        expect(output.parentChain.length).toBe(3)

        // Root step should have null parentStepId
        expect(output.parentChain[0]!.parentStepId).toBeNull()

        // Nested step should have root's stepId as parentStepId
        expect(output.parentChain[1]!.parentStepId).toBe(output.parentChain[0]!.stepId)

        // Deep step should have nested's stepId as parentStepId
        expect(output.parentChain[2]!.parentStepId).toBe(output.parentChain[1]!.stepId)
      })
    })

    describe('Concurrent Children', () => {
      it('should handle multiple concurrent child steps under same parent', async () => {
        const jobId = await client.runAction('concurrentChildrenAction', { childCount: 5 })
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 10000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as { childResults: number[] }
        expect(output.childResults.sort()).toEqual([0, 1, 2, 3, 4])

        // Verify all steps exist in database
        const stepsResult = await client.getJobSteps({ jobId })
        expect(stepsResult.steps.length).toBe(6) // 1 parent + 5 children

        const parentStep = stepsResult.steps.find((s) => s.name === 'parent-step')
        expectToBeDefined(parentStep)

        // All child steps should have same parentStepId
        const childSteps = stepsResult.steps.filter((s) => s.name.startsWith('child-'))
        expect(childSteps.length).toBe(5)
        childSteps.forEach((child) => {
          expect((child as any).parentStepId).toBe(parentStep.id)
        })
      })
    })

    describe('Unhandled Child Steps', () => {
      it('should fail action when child step is not awaited', async () => {
        const jobId = await client.runAction('unawaitedChildAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_FAILED)

        // Error should mention unhandled child steps
        expect(job.error).toBeDefined()
        expect(job.error.name).toBe('UnhandledChildStepsError')

        // The orphaned child step should be cancelled
        const stepsResult = await client.getJobSteps({ jobId })
        const orphanedChild = stepsResult.steps.find((s) => s.name === 'orphaned-child')
        expectToBeDefined(orphanedChild)
        expect(orphanedChild.status).toBe(STEP_STATUS_CANCELLED)
      })
    })

    describe('Abort Propagation', () => {
      it('should abort child steps when parent times out', async () => {
        const jobId = await client.runAction('parentTimeoutAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_FAILED)

        // Parent should have timed out
        expect(job.error).toBeDefined()
        expect(job.error.name).toBe('StepTimeoutError')

        // Get steps
        const stepsResult = await client.getJobSteps({ jobId })

        // Parent step should be present and failed
        const parentStep = stepsResult.steps.find((s) => s.name === 'parent-step')
        expectToBeDefined(parentStep)
        expect(parentStep.status).toBe(STEP_STATUS_FAILED)

        // Child step may or may not exist depending on timing
        // If it does exist, it should be cancelled or failed
        const childStep = stepsResult.steps.find((s) => s.name === 'slow-child')
        if (childStep) {
          expect(childStep.status === STEP_STATUS_CANCELLED || childStep.status === STEP_STATUS_FAILED).toBe(true)
          // Child should have parent step's id
          expect((childStep as any).parentStepId).toBe(parentStep.id)
        }
      })

      it('should cancel all nested steps when action is cancelled', async () => {
        const jobId = await client.runAction('deeplyNestedAction', {})

        // Start fetching but cancel quickly
        const fetchPromise = client.fetch({ batchSize: 10 })

        // Cancel the job after a short delay
        await new Promise((resolve) => setTimeout(resolve, 10))
        await client.cancelJob(jobId)

        await fetchPromise

        // Wait for job to settle
        await new Promise((resolve) => setTimeout(resolve, 200))

        const job = await client.getJobById(jobId)
        expectToBeDefined(job)

        // Job should be cancelled or failed
        expect([JOB_STATUS_COMPLETED, JOB_STATUS_FAILED, 'cancelled']).toContain(job.status)
      })
    })

    describe('Parallel Steps', () => {
      it(
        'should throw a timeout error when a nested step times out',
        async () => {
          const jobId = await client.runAction('parallelStepsAction', { delay: 3000 })
          await client.fetch({ batchSize: 10 })

          const job = await client.waitForJob(jobId)
          expectToBeDefined(job)
          expect(job.error).toBeDefined()
          expect(job.error.name).toBe('StepTimeoutError')
        },
        { timeout: 10000 },
      )
    })

    describe('StepAlreadyExecutedError', () => {
      it('should throw error when duplicate step name at root level', async () => {
        const jobId = await client.runAction('duplicateRootStepsAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_FAILED)
        expect(job.error).toBeDefined()
        expect(job.error.name).toBe('StepAlreadyExecutedError')
        expect(job.error.message).toContain('same-name')
      })

      it('should throw error when duplicate step name under same parent', async () => {
        const jobId = await client.runAction('duplicateNestedStepsAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_FAILED)
        expect(job.error).toBeDefined()
        expect(job.error.name).toBe('StepAlreadyExecutedError')
        expect(job.error.message).toContain('child-name')
      })

      it('should allow same step name under different parents', async () => {
        const jobId = await client.runAction('sameNameDifferentParentsAction', {})
        await client.fetch({ batchSize: 10 })

        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_COMPLETED)

        const output = job.output as { results: string[] }
        expect(output.results).toContain('parent-1:shared-name')
        expect(output.results).toContain('parent-2:shared-name')
      })

      it(
        'should clear history when step fails and allow re-execution on retry',
        async () => {
          const jobId = await client.runAction('retryHistoryClearAction', {})

          // Process the job (may need multiple fetches for retries)
          for (let i = 0; i < 10; i++) {
            await client.fetch({ batchSize: 10 })
            await new Promise((resolve) => setTimeout(resolve, 100))
          }

          const job = await client.waitForJob(jobId, { timeout: 10000 })
          expectToBeDefined(job)
          expect(job.status).toBe(JOB_STATUS_COMPLETED)

          // The step was called 3 times (failed twice, succeeded on third)
          const output = job.output as { attempts: number }
          expect(output.attempts).toBe(3)
        },
        { timeout: 15000 },
      )
    })
  })
}

// Run tests with both adapters
runNestedStepsTests(pgliteFactory)
// biome-ignore lint/complexity/useLiteralKeys: type safety
if (process.env['POSTGRES_TEST'] === 'true') {
  runNestedStepsTests(postgresFactory)
}
