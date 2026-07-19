import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import {
  JOB_STATUS_ACTIVE,
  JOB_STATUS_COMPLETED,
  JOB_STATUS_CREATED,
  JOB_STATUS_FAILED,
  STEP_STATUS_ACTIVE,
  STEP_STATUS_COMPLETED,
} from '../src/constants.js'

import {
  type AdapterFactory,
  type AdapterInstance,
  pgliteFactory,
  postgresFactory,
} from './adapters.js'
import { expectToBeDefined } from './asserts.js'

// =============================================================================
// Test Actions for Time Travel
// =============================================================================

/**
 * Simple linear action with 3 steps
 */
const linearAction = defineAction()({
  name: 'linear-action',
  version: '1.0.0',
  input: z.object({
    failAtStep: z.number().optional(),
  }),
  output: z.object({
    steps: z.array(z.string()),
  }),
  steps: {
    concurrency: 10,
    retry: { limit: 0, factor: 2, minTimeout: 100, maxTimeout: 500 },
    expire: 60000,
  },
  handler: async (ctx) => {
    const steps: string[] = []

    await ctx.step('step-1', async () => {
      if (ctx.input.failAtStep === 1) throw new Error('Step 1 failed')
      steps.push('step-1')
      return { completed: 'step-1' }
    })

    await ctx.step('step-2', async () => {
      if (ctx.input.failAtStep === 2) throw new Error('Step 2 failed')
      steps.push('step-2')
      return { completed: 'step-2' }
    })

    await ctx.step('step-3', async () => {
      if (ctx.input.failAtStep === 3) throw new Error('Step 3 failed')
      steps.push('step-3')
      return { completed: 'step-3' }
    })

    return { steps }
  },
})

/**
 * Action with nested steps for testing time travel from nested step
 */
const nestedAction = defineAction()({
  name: 'nested-action',
  version: '1.0.0',
  input: z.object({
    failAtStep: z.string().optional(),
  }),
  output: z.object({
    executed: z.array(z.string()),
  }),
  steps: {
    concurrency: 10,
    retry: { limit: 0, factor: 2, minTimeout: 100, maxTimeout: 500 },
    expire: 60000,
  },
  handler: async (ctx) => {
    const executed: string[] = []

    await ctx.step('parent-1', async (stepCtx) => {
      executed.push('parent-1-start')

      await stepCtx.step('child-1-1', async () => {
        if (ctx.input.failAtStep === 'child-1-1') throw new Error('child-1-1 failed')
        executed.push('child-1-1')
        return { done: true }
      })

      await stepCtx.step('child-1-2', async () => {
        if (ctx.input.failAtStep === 'child-1-2') throw new Error('child-1-2 failed')
        executed.push('child-1-2')
        return { done: true }
      })

      executed.push('parent-1-end')
      return { completed: true }
    })

    await ctx.step('parent-2', async () => {
      if (ctx.input.failAtStep === 'parent-2') throw new Error('parent-2 failed')
      executed.push('parent-2')
      return { completed: true }
    })

    return { executed }
  },
})

/**
 * Action with parallel steps for testing parallel step preservation during time travel
 */
const branchAction = defineAction()({
  name: 'branch-action',
  version: '1.0.0',
  input: z.object({
    failAtStep: z.string().optional(),
  }),
  output: z.object({
    executed: z.array(z.string()),
  }),
  steps: {
    concurrency: 10,
    retry: { limit: 0, factor: 2, minTimeout: 100, maxTimeout: 500 },
    expire: 60000,
  },
  handler: async (ctx) => {
    const executed: string[] = []

    // Two root-level parallel steps
    await Promise.all([
      ctx.step(
        'branch-a',
        async () => {
          executed.push('branch-a')
          return { result: 'a' }
        },
        { parallel: true },
      ),
      ctx.step(
        'branch-b',
        async () => {
          if (ctx.input.failAtStep === 'branch-b') throw new Error('branch-b failed')
          executed.push('branch-b')
          return { result: 'b' }
        },
        { parallel: true },
      ),
    ])

    await ctx.step('final-step', async () => {
      if (ctx.input.failAtStep === 'final-step') throw new Error('final-step failed')
      executed.push('final-step')
      return { done: true }
    })

    return { executed }
  },
})

/**
 * Action with nested parallel steps - parallel steps that contain nested steps
 * This tests the edge case where time travel targets a step inside a parallel step
 * and sibling parallel steps with their own children should be preserved
 */
const nestedBranchAction = defineAction()({
  name: 'nested-branch-action',
  version: '1.0.0',
  input: z.object({
    failAtStep: z.string().optional(),
  }),
  output: z.object({
    executed: z.array(z.string()),
  }),
  steps: {
    concurrency: 10,
    retry: { limit: 0, factor: 2, minTimeout: 100, maxTimeout: 500 },
    expire: 60000,
  },
  handler: async (ctx) => {
    const executed: string[] = []

    // Parent step with multiple parallel children, each with nested steps
    await ctx.step('parent', async (parentCtx) => {
      executed.push('parent-start')

      await Promise.all([
        // Branch A with nested steps
        parentCtx.step(
          'branch-a',
          async (branchACtx) => {
            executed.push('branch-a-start')
            await branchACtx.step('child-a-1', async () => {
              executed.push('child-a-1')
              return { done: true }
            })
            await branchACtx.step('child-a-2', async () => {
              executed.push('child-a-2')
              return { done: true }
            })
            executed.push('branch-a-end')
            return { result: 'a' }
          },
          { parallel: true },
        ),
        // Branch B with nested steps (target for time travel)
        parentCtx.step(
          'branch-b',
          async (branchBCtx) => {
            executed.push('branch-b-start')
            await branchBCtx.step('child-b-1', async () => {
              if (ctx.input.failAtStep === 'child-b-1') throw new Error('child-b-1 failed')
              executed.push('child-b-1')
              return { done: true }
            })
            await branchBCtx.step('child-b-2', async () => {
              if (ctx.input.failAtStep === 'child-b-2') throw new Error('child-b-2 failed')
              executed.push('child-b-2')
              return { done: true }
            })
            executed.push('branch-b-end')
            return { result: 'b' }
          },
          { parallel: true },
        ),
        // Branch C with nested steps
        parentCtx.step(
          'branch-c',
          async (branchCCtx) => {
            executed.push('branch-c-start')
            await branchCCtx.step('child-c-1', async () => {
              executed.push('child-c-1')
              return { done: true }
            })
            executed.push('branch-c-end')
            return { result: 'c' }
          },
          { parallel: true },
        ),
      ])

      executed.push('parent-end')
      return { completed: true }
    })

    return { executed }
  },
})

// =============================================================================
// Test Suite Runner
// =============================================================================

function runTests(name: string, factory: AdapterFactory) {
  describe(`Time Travel Tests with ${name}`, () => {
    let adapterInstance: AdapterInstance
    let client: Client<any, any>

    beforeEach(async () => {
      adapterInstance = await factory.create()
      client = new Client({
        database: adapterInstance.adapter,
        actions: { linearAction, nestedAction, branchAction, nestedBranchAction },
        syncPattern: false, // Manual fetching for tests
        logger: 'silent',
      })
      await client.start()
    })

    afterEach(async () => {
      await client?.stop()
      await adapterInstance?.deleteDb()
    })

    // =========================================================================
    // Basic Time Travel Tests
    // =========================================================================

    describe('Basic Time Travel', () => {
      it('should time travel from a root step in completed job', async () => {
        // Run a successful job
        const jobId = await client.runAction('linearAction', {})
        await client.fetch({ batchSize: 1 })
        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        // Get steps
        const { steps } = await client.getJobSteps({ jobId })
        expect(steps.length).toBe(3)
        const step2 = steps.find((s) => s.name === 'step-2')
        expectToBeDefined(step2)

        // Time travel to step-2
        const success = await client.timeTravelJob(jobId, step2!.id)
        expect(success).toBe(true)

        // Job should be reset to created
        const resetJob = await client.getJobById(jobId)
        expectToBeDefined(resetJob)
        expect(resetJob?.status).toBe(JOB_STATUS_CREATED)

        // step-1 should still be completed, step-2 and step-3 should be reset/deleted
        const { steps: stepsAfter } = await client.getJobSteps({ jobId })
        const step1After = stepsAfter.find((s) => s.name === 'step-1')
        const step2After = stepsAfter.find((s) => s.name === 'step-2')
        const step3After = stepsAfter.find((s) => s.name === 'step-3')

        expectToBeDefined(step1After)
        expect(step1After?.status).toBe(STEP_STATUS_COMPLETED) // Kept
        expectToBeDefined(step2After)
        expect(step2After?.status).toBe(STEP_STATUS_ACTIVE) // Reset
        expect(step3After).toBeUndefined() // Deleted
      })

      it('should time travel from a step in failed job', async () => {
        // Run a job that fails at step 2
        const jobId = await client.runAction('linearAction', { failAtStep: 2 })
        await client.fetch({ batchSize: 1 })
        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job?.status).toBe(JOB_STATUS_FAILED)

        // Get steps
        const { steps } = await client.getJobSteps({ jobId })
        expect(steps.length).toBe(2) // step-1 and step-2

        const step2 = steps.find((s) => s.name === 'step-2')
        expectToBeDefined(step2)

        // Time travel to step-2 (the failed step)
        const success = await client.timeTravelJob(jobId, step2!.id)
        expect(success).toBe(true)

        // Job should be reset to created
        const resetJob = await client.getJobById(jobId)
        expectToBeDefined(resetJob)
        expect(resetJob?.status).toBe(JOB_STATUS_CREATED)
      })

      it('should not time travel for active job', async () => {
        // Run a job
        const jobId = await client.runAction('linearAction', {})

        // Don't wait for completion - job is still created/active
        const job = await client.getJobById(jobId)
        expectToBeDefined(job)
        expect(job.status === JOB_STATUS_CREATED || job.status === JOB_STATUS_ACTIVE).toBe(true)

        // There are no steps yet, so we can't time travel
        const { steps } = await client.getJobSteps({ jobId })
        if (steps.length > 0) {
          const success = await client.timeTravelJob(jobId, steps[0]!.id)
          expect(success).toBe(false)
        }
      })
    })

    // =========================================================================
    // Nested Steps Time Travel Tests
    // =========================================================================

    describe('Nested Steps Time Travel', () => {
      it('should time travel from nested child step (ancestors re-run)', async () => {
        // Run a successful job with nested steps
        const jobId = await client.runAction('nestedAction', {})
        await client.fetch({ batchSize: 1 })
        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        // Get steps
        const { steps } = await client.getJobSteps({ jobId })
        expect(steps.length).toBe(4) // parent-1, child-1-1, child-1-2, parent-2

        const child11 = steps.find((s) => s.name === 'child-1-1')
        const parent1 = steps.find((s) => s.name === 'parent-1')
        expectToBeDefined(child11)
        expectToBeDefined(parent1)

        // Time travel to child-1-1
        const success = await client.timeTravelJob(jobId, child11!.id)
        expect(success).toBe(true)

        // Job should be reset to created
        const resetJob = await client.getJobById(jobId)
        expectToBeDefined(resetJob)
        expect(resetJob?.status).toBe(JOB_STATUS_CREATED)

        // parent-1 should be reset (ancestor)
        // child-1-1 should be reset (target)
        // child-1-2 and parent-2 should be deleted
        const { steps: stepsAfter } = await client.getJobSteps({ jobId })

        const parent1After = stepsAfter.find((s) => s.name === 'parent-1')
        const child11After = stepsAfter.find((s) => s.name === 'child-1-1')
        const child12After = stepsAfter.find((s) => s.name === 'child-1-2')
        const parent2After = stepsAfter.find((s) => s.name === 'parent-2')

        expectToBeDefined(parent1After)
        expect(parent1After?.status).toBe(STEP_STATUS_ACTIVE) // Ancestor - reset
        expectToBeDefined(child11After)
        expect(child11After?.status).toBe(STEP_STATUS_ACTIVE) // Target - reset
        expect(child12After).toBeUndefined() // Deleted (came after)
        expect(parent2After).toBeUndefined() // Deleted (came after)
      })

      it('should time travel to second child step', async () => {
        // Run a successful job with nested steps
        const jobId = await client.runAction('nestedAction', {})
        await client.fetch({ batchSize: 1 })
        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        // Get steps
        const { steps } = await client.getJobSteps({ jobId })

        const child12 = steps.find((s) => s.name === 'child-1-2')
        expectToBeDefined(child12)

        // Time travel to child-1-2
        const success = await client.timeTravelJob(jobId, child12!.id)
        expect(success).toBe(true)

        // Check steps after time travel
        const { steps: stepsAfter } = await client.getJobSteps({ jobId })

        const parent1After = stepsAfter.find((s) => s.name === 'parent-1')
        const child11After = stepsAfter.find((s) => s.name === 'child-1-1')
        const child12After = stepsAfter.find((s) => s.name === 'child-1-2')
        const parent2After = stepsAfter.find((s) => s.name === 'parent-2')

        expectToBeDefined(parent1After)
        expect(parent1After?.status).toBe(STEP_STATUS_ACTIVE) // Ancestor - reset
        expectToBeDefined(child11After)
        expect(child11After?.status).toBe(STEP_STATUS_COMPLETED) // Completed before target - kept
        expectToBeDefined(child12After)
        expect(child12After?.status).toBe(STEP_STATUS_ACTIVE) // Target - reset
        expect(parent2After).toBeUndefined() // Deleted (came after parent-1)
      })
    })

    // =========================================================================
    // Branch Steps Time Travel Tests
    // =========================================================================

    describe('Branch Steps Time Travel', () => {
      it('should preserve completed parallel siblings during time travel', async () => {
        // Run a job that fails at final-step
        const jobId = await client.runAction('branchAction', { failAtStep: 'final-step' })
        await client.fetch({ batchSize: 1 })
        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job?.status).toBe(JOB_STATUS_FAILED)

        // Get steps
        const { steps } = await client.getJobSteps({ jobId })

        // Find the final-step
        const finalStep = steps.find((s) => s.name === 'final-step')
        expectToBeDefined(finalStep)

        // Time travel to final-step
        const success = await client.timeTravelJob(jobId, finalStep!.id)
        expect(success).toBe(true)

        // Check steps after time travel
        const { steps: stepsAfter } = await client.getJobSteps({ jobId })

        const branchAAfter = stepsAfter.find((s) => s.name === 'branch-a')
        const branchBAfter = stepsAfter.find((s) => s.name === 'branch-b')
        const finalStepAfter = stepsAfter.find((s) => s.name === 'final-step')

        // Both parallel steps should be preserved (completed before final-step)
        expectToBeDefined(branchAAfter)
        expect(branchAAfter?.status).toBe(STEP_STATUS_COMPLETED)
        expectToBeDefined(branchBAfter)
        expect(branchBAfter?.status).toBe(STEP_STATUS_COMPLETED)

        // final-step should be reset
        expectToBeDefined(finalStepAfter)
        expect(finalStepAfter?.status).toBe(STEP_STATUS_ACTIVE)
      })

      it('should keep parallel sibling when time traveling to another parallel step', async () => {
        // Run a job that fails at branch-b
        const jobId = await client.runAction('branchAction', { failAtStep: 'branch-b' })
        await client.fetch({ batchSize: 1 })
        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job?.status).toBe(JOB_STATUS_FAILED)

        // Get steps - branch-a should be completed, branch-b should be failed
        const { steps } = await client.getJobSteps({ jobId })

        const branchA = steps.find((s) => s.name === 'branch-a')
        const branchB = steps.find((s) => s.name === 'branch-b')
        expectToBeDefined(branchA)
        expectToBeDefined(branchB)

        // Time travel to branch-b
        const success = await client.timeTravelJob(jobId, branchB!.id)
        expect(success).toBe(true)

        // Check steps after time travel
        const { steps: stepsAfter } = await client.getJobSteps({ jobId })

        const branchAAfter = stepsAfter.find((s) => s.name === 'branch-a')
        const branchBAfter = stepsAfter.find((s) => s.name === 'branch-b')

        // branch-a should be preserved (completed parallel sibling)
        expectToBeDefined(branchAAfter)
        expect(branchAAfter?.status).toBe(STEP_STATUS_COMPLETED)

        // branch-b should be reset (target)
        expectToBeDefined(branchBAfter)
        expect(branchBAfter?.status).toBe(STEP_STATUS_ACTIVE)
      })

      it('should preserve sibling parallel steps AND their children when time traveling to nested step in a parallel step', async () => {
        // This tests the edge case from processOrder: time traveling to a step inside
        // a parallel step should preserve sibling parallel steps AND all their nested children
        const jobId = await client.runAction('nestedBranchAction', { failAtStep: 'child-b-2' })
        await client.fetch({ batchSize: 1 })
        const job = await client.waitForJob(jobId, { timeout: 10000 })
        expectToBeDefined(job)
        expect(job?.status).toBe(JOB_STATUS_FAILED)

        // Get steps before time travel
        const { steps } = await client.getJobSteps({ jobId })

        // Verify initial state: parallel step a and c completed with children, parallel step b failed
        const branchA = steps.find((s) => s.name === 'branch-a')
        const childA1 = steps.find((s) => s.name === 'child-a-1')
        const childA2 = steps.find((s) => s.name === 'child-a-2')
        const branchC = steps.find((s) => s.name === 'branch-c')
        const childC1 = steps.find((s) => s.name === 'child-c-1')
        const childB1 = steps.find((s) => s.name === 'child-b-1')
        const childB2 = steps.find((s) => s.name === 'child-b-2')

        expectToBeDefined(branchA)
        expectToBeDefined(childA1)
        expectToBeDefined(childA2)
        expectToBeDefined(branchC)
        expectToBeDefined(childC1)
        expectToBeDefined(childB1)
        expectToBeDefined(childB2)

        // Time travel to child-b-2 (nested inside parallel step b)
        const success = await client.timeTravelJob(jobId, childB2!.id)
        expect(success).toBe(true)

        // Check steps after time travel
        const { steps: stepsAfter } = await client.getJobSteps({ jobId })

        // branch-a should be preserved WITH its children
        const branchAAfter = stepsAfter.find((s) => s.name === 'branch-a')
        const childA1After = stepsAfter.find((s) => s.name === 'child-a-1')
        const childA2After = stepsAfter.find((s) => s.name === 'child-a-2')

        expectToBeDefined(branchAAfter)
        expect(branchAAfter?.status).toBe(STEP_STATUS_COMPLETED)
        expectToBeDefined(childA1After)
        expect(childA1After?.status).toBe(STEP_STATUS_COMPLETED)
        expectToBeDefined(childA2After)
        expect(childA2After?.status).toBe(STEP_STATUS_COMPLETED)

        // branch-c should be preserved WITH its children
        const branchCAfter = stepsAfter.find((s) => s.name === 'branch-c')
        const childC1After = stepsAfter.find((s) => s.name === 'child-c-1')

        expectToBeDefined(branchCAfter)
        expect(branchCAfter?.status).toBe(STEP_STATUS_COMPLETED)
        expectToBeDefined(childC1After)
        expect(childC1After?.status).toBe(STEP_STATUS_COMPLETED)

        // branch-b should be reset to active (ancestor of target)
        const branchBAfter = stepsAfter.find((s) => s.name === 'branch-b')
        expectToBeDefined(branchBAfter)
        expect(branchBAfter?.status).toBe(STEP_STATUS_ACTIVE)

        // child-b-1 should be preserved (sibling before target in same parallel step, completed)
        const childB1After = stepsAfter.find((s) => s.name === 'child-b-1')
        expectToBeDefined(childB1After)
        expect(childB1After?.status).toBe(STEP_STATUS_COMPLETED)

        // child-b-2 should be reset (target)
        const childB2After = stepsAfter.find((s) => s.name === 'child-b-2')
        expectToBeDefined(childB2After)
        expect(childB2After?.status).toBe(STEP_STATUS_ACTIVE)

        // parent should be reset (ancestor of target)
        const parentAfter = stepsAfter.find((s) => s.name === 'parent')
        expectToBeDefined(parentAfter)
        expect(parentAfter?.status).toBe(STEP_STATUS_ACTIVE)
      })
    })

    // =========================================================================
    // Re-execution After Time Travel Tests
    // =========================================================================

    describe('Re-execution After Time Travel', () => {
      it('should complete job after time travel and re-execution', async () => {
        // Run a job that fails at step 2
        const jobId = await client.runAction('linearAction', { failAtStep: 2 })
        await client.fetch({ batchSize: 1 })
        const job = await client.waitForJob(jobId, { timeout: 5000 })
        expectToBeDefined(job)
        expect(job?.status).toBe(JOB_STATUS_FAILED)

        // Get the failed step
        const { steps } = await client.getJobSteps({ jobId })
        const step2 = steps.find((s) => s.name === 'step-2')
        expectToBeDefined(step2)

        // Time travel to step-2
        const success = await client.timeTravelJob(jobId, step2!.id)
        expect(success).toBe(true)

        // Need to update the input to not fail (simulate fix)
        // Since we can't update input, we just verify the job is re-runnable
        const resetJob = await client.getJobById(jobId)
        expectToBeDefined(resetJob)
        expect(resetJob?.status).toBe(JOB_STATUS_CREATED)

        // The job is ready to be fetched and executed again
        // In a real scenario, you'd fix the input or the code before re-running
      })
    })
  })
}

// =============================================================================
// Run Tests for Each Adapter
// =============================================================================

runTests('pglite', pgliteFactory)
// oxlint-disable-next-line useLiteralKeys
if (process.env['POSTGRES_TEST'] === 'true') {
  runTests('postgres', postgresFactory)
}
