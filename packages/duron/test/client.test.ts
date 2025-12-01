import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import {
  JOB_STATUS_CANCELLED,
  JOB_STATUS_COMPLETED,
  JOB_STATUS_CREATED,
  JOB_STATUS_FAILED,
  STEP_STATUS_CANCELLED,
} from '../src/constants.js'
import { type Adapter, type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'
import { expectRejection, expectToBeDefined } from './asserts.js'

const testAction = defineAction()({
  name: 'test-action',
  version: '1.0.0',
  input: z.object({
    message: z.string(),
    value: z.number().optional(),
  }),
  output: z.object({
    result: z.string(),
  }),
  handler: async (ctx) => {
    await ctx.step('step-1', async () => {
      return { processed: true }
    })

    return {
      result: `Processed: ${ctx.input?.message}`,
    }
  },
})

const failingAction = defineAction()({
  name: 'failing-action',
  version: '1.0.0',
  input: z.object({
    shouldFail: z.boolean(),
  }),
  output: z.object({
    result: z.string(),
  }),
  handler: async (ctx) => {
    if (ctx.input.shouldFail) {
      throw new Error('Action failed intentionally')
    }
    return { result: 'success' }
  },
})

const slowAction = defineAction()({
  name: 'slow-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    result: z.string(),
  }),
  handler: async (_ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return { result: 'completed' }
  },
})

const slowStepAction = defineAction()({
  name: 'slow-step-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    result: z.string(),
  }),
  handler: async (ctx) => {
    await ctx.step('slow-step', async () => {
      // Slow step that takes 500ms
      await new Promise((resolve) => setTimeout(resolve, 500))
      return { processed: true }
    })
    return { result: 'completed' }
  },
})

function runClientTests(adapterFactory: AdapterFactory) {
  describe(`Client Tests with ${adapterFactory.name}`, () => {
    let client: Client<
      {
        testAction: typeof testAction
        failingAction: typeof failingAction
        slowAction: typeof slowAction
        slowStepAction: typeof slowStepAction
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
            testAction,
            failingAction,
            slowAction,
            slowStepAction,
          },
          syncPattern: false, // Disable auto-fetch for manual control in tests
          recoverJobsOnStart: false,
          logger: 'error',
        })
      },
      {
        timeout: 60_000,
      },
    )

    afterEach(async () => {
      if (client) {
        await client.stop()
      }
      if (deleteDb) {
        await deleteDb()
      }
    })

    describe('Lifecycle', () => {
      it('should start and stop the client', async () => {
        const started = await client.start()
        expect(started).toBe(true)

        const stopped = await client.stop()
        expect(stopped).toBe(true)
      })

      it('should handle multiple start calls', async () => {
        const promise1 = client.start()
        const promise2 = client.start()
        const promise3 = client.start()

        const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3])

        expect(result1).toBe(true)
        expect(result2).toBe(true)
        expect(result3).toBe(true)
      })

      it('should not start after stopping', async () => {
        await client.start()
        await client.stop()

        const started = await client.start()
        expect(started).toBe(false)
      })
    })

    describe('Running Actions', () => {
      beforeEach(async () => {
        await client.start()
      })

      it('should run an action and create a job', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Hello World',
          value: 42,
        })

        expect(jobId).toBeTruthy()
        expect(typeof jobId).toBe('string')

        const job = await client.getJobById(jobId)
        expect(job).toBeTruthy()
        expect(job?.actionName).toBe('test-action')
        expect(job?.status).toBe(JOB_STATUS_CREATED)
        expect(job?.input).toEqual({ message: 'Hello World', value: 42 })
      })

      it('should validate input against action schema', async () => {
        await expectRejection(() =>
          client.runAction('testAction', {
            invalid: 'field',
          } as any),
        )
      })

      it('should handle actions without input schema', async () => {
        const actionWithoutInput = defineAction()({
          name: 'no-input-action',
          input: undefined,
          output: z.object({ result: z.string() }),
          handler: async () => ({ result: 'done' }),
        })

        const testClient = new Client({
          database,
          actions: {
            noInputAction: actionWithoutInput,
          },
          syncPattern: false,
          logger: 'error',
        })

        await testClient.start()

        const jobId = await testClient.runAction('noInputAction')
        expect(jobId).toBeTruthy()

        await testClient.stop()
      })
    })

    describe('Job Processing', () => {
      beforeEach(async () => {
        await client.start()
      })

      it('should fetch and process jobs', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Process me',
        })

        // Manually fetch and process
        const fetchedJobs = await client.fetch({ batchSize: 10 })

        expect(fetchedJobs.length).toBeGreaterThan(0)
        expect(fetchedJobs.some((job) => job.id === jobId)).toBe(true)

        // Wait for job to complete
        await new Promise((resolve) => setTimeout(resolve, 500))

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)
        expect(job?.output).toEqual({ result: 'Processed: Process me' })
      })

      it('should handle failing actions', async () => {
        const jobId = await client.runAction('failingAction', {
          shouldFail: true,
        })

        await client.fetch({ batchSize: 10 })

        // Wait for job to fail
        await new Promise((resolve) => setTimeout(resolve, 500))

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_FAILED)
        expect(job?.error).toBeTruthy()
      })

      it('should respect batch size when fetching', async () => {
        // Create multiple jobs
        const jobIds = []
        for (let i = 0; i < 5; i++) {
          const jobId = await client.runAction('testAction', {
            message: `Job ${i}`,
          })
          jobIds.push(jobId)
        }

        const fetchedJobs = await client.fetch({ batchSize: 2 })

        expect(fetchedJobs.length).toBeLessThanOrEqual(2)
      })
    })

    describe('Sync Patterns', () => {
      it('should use pull pattern to fetch jobs periodically', async () => {
        const pullClient = new Client({
          database,
          actions: {
            testAction,
          },
          syncPattern: 'pull',
          pullInterval: 100, // Fast interval for testing
          batchSize: 10,
          logger: 'error',
        })

        await pullClient.start()

        const jobId = await pullClient.runAction('testAction', {
          message: 'Pull test',
        })

        // Wait for pull loop to fetch and process
        await new Promise((resolve) => setTimeout(resolve, 500))

        const job = await pullClient.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        await pullClient.stop()
      })

      it('should use push pattern to fetch jobs on notification', async () => {
        const pushClient = new Client({
          database,
          actions: {
            testAction,
          },
          syncPattern: 'push',
          batchSize: 10,
          logger: 'error',
        })

        await pushClient.start()

        const jobId = await pushClient.runAction('testAction', {
          message: 'Push test',
        })

        // Wait for push notification to trigger fetch
        await new Promise((resolve) => setTimeout(resolve, 500))

        const job = await pushClient.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        await pushClient.stop()
      })

      it('should use hybrid pattern to fetch jobs', async () => {
        const hybridClient = new Client({
          database,
          actions: {
            testAction,
          },
          syncPattern: 'hybrid',
          pullInterval: 200,
          batchSize: 10,
          logger: 'error',
        })

        await hybridClient.start()

        const jobId = await hybridClient.runAction('testAction', {
          message: 'Hybrid test',
        })

        // Wait for either push or pull to process
        await new Promise((resolve) => setTimeout(resolve, 500))

        const job = await hybridClient.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        await hybridClient.stop()
      })
    })

    describe('Job Cancellation', () => {
      beforeEach(async () => {
        await client.start()
      })

      it('should cancel a job', async () => {
        const jobId = await client.runAction('slowAction', {})

        // Start processing
        client.fetch({ batchSize: 10 })

        // Cancel immediately
        await client.cancelJob(jobId)

        // Wait a bit
        await new Promise((resolve) => setTimeout(resolve, 200))

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_CANCELLED)
      })

      it('should cancel a job before it starts processing', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Cancel me',
        })

        await client.cancelJob(jobId)

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_CANCELLED)
      })

      it('should cancel a job with a slow step', async () => {
        const jobId = await client.runAction('slowStepAction', {})

        // Start processing
        client.fetch({ batchSize: 10 })

        // Wait a bit to let the step start executing
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Cancel while the step is executing
        await client.cancelJob(jobId)

        // Wait for cancellation to complete
        await new Promise((resolve) => setTimeout(resolve, 200))

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_CANCELLED)

        // Verify the step is also cancelled
        const steps = await client.getJobSteps({
          jobId,
          page: 1,
          pageSize: 10,
        })

        expect(steps.steps.length).toBeGreaterThan(0)
        const slowStep = steps.steps.find((step) => step.name === 'slow-step')
        expect(slowStep).toBeTruthy()
        expect(slowStep?.status).toBe(STEP_STATUS_CANCELLED)
      })
    })

    describe('Job Retry', () => {
      beforeEach(async () => {
        await client.start()
      })

      it('should retry a failed job', async () => {
        const jobId = await client.runAction('failingAction', {
          shouldFail: true,
        })

        await client.fetch({ batchSize: 10 })

        // Wait for job to fail
        await new Promise((resolve) => setTimeout(resolve, 500))

        const originalJob = await client.getJobById(jobId)
        expect(originalJob?.status).toBe(JOB_STATUS_FAILED)

        const retryJobId = await client.retryJob(jobId)
        expectToBeDefined(retryJobId)
        expect(retryJobId).not.toBe(jobId)

        const retryJob = await client.getJobById(retryJobId)
        expect(retryJob?.status).toBe(JOB_STATUS_CREATED)
        expect(retryJob?.input).toEqual({ shouldFail: true })
      })
    })

    describe('Query Methods', () => {
      beforeEach(async () => {
        await client.start()
      })

      it('should get jobs with pagination', async () => {
        // Create multiple jobs
        for (let i = 0; i < 5; i++) {
          await client.runAction('testAction', {
            message: `Job ${i}`,
          })
        }

        const result = await client.getJobs({
          page: 1,
          pageSize: 2,
        })

        expect(result.jobs.length).toBe(2)
        expect(result.total).toBe(5)
        expect(result.page).toBe(1)
        expect(result.pageSize).toBe(2)
      })

      it('should filter jobs by status', async () => {
        const jobId1 = await client.runAction('testAction', {
          message: 'Job 1',
        })

        const jobId2 = await client.runAction('testAction', {
          message: 'Job 2',
        })

        // Process first job
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const completedJobs = await client.getJobs({
          filters: {
            status: JOB_STATUS_COMPLETED,
          },
        })

        expect(completedJobs.jobs.length).toBeGreaterThan(0)
        expect(completedJobs.jobs.some((job) => job.id === jobId1 || job.id === jobId2)).toBe(true)
      })

      it('should filter jobs by action name', async () => {
        await client.runAction('testAction', {
          message: 'Test action',
        })

        await client.runAction('failingAction', {
          shouldFail: false,
        })

        const result = await client.getJobs({
          filters: {
            actionName: 'test-action',
          },
        })

        expect(result.jobs.length).toBeGreaterThan(0)
        expect(result.jobs.every((job) => job.actionName === 'test-action')).toBe(true)
      })

      it('should get job steps', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Get steps',
        })

        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const result = await client.getJobSteps({
          jobId,
          page: 1,
          pageSize: 10,
        })

        expect(result.steps.length).toBeGreaterThan(0)
        expect(result.steps.some((step) => step.name === 'step-1')).toBe(true)
      })

      it('should get action statistics', async () => {
        await client.runAction('testAction', {
          message: 'Stats test',
        })

        await client.runAction('failingAction', {
          shouldFail: false,
        })

        const result = await client.getActions()

        expect(result.actions.length).toBeGreaterThanOrEqual(2)
        const testActionStats = result.actions.find((a) => a.name === 'test-action')
        const failingActionStats = result.actions.find((a) => a.name === 'failing-action')

        expect(testActionStats).toBeTruthy()
        expect(failingActionStats).toBeTruthy()
      })
    })

    describe('waitForJob', () => {
      beforeEach(async () => {
        await client.start()
      })

      it('should wait for a job to complete', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Wait for me',
        })

        // Start processing in the background
        client.fetch({ batchSize: 10 })

        // Wait for the job to complete
        const job = await client.waitForJob(jobId, { timeout: 5000 })

        expect(job).toBeTruthy()
        expect(job?.id).toBe(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)
        expect(job?.output).toEqual({ result: 'Processed: Wait for me' })
      })

      it('should wait for a job to fail', async () => {
        const jobId = await client.runAction('failingAction', {
          shouldFail: true,
        })

        // Start processing in the background
        client.fetch({ batchSize: 10 })

        // Wait for the job to fail
        const job = await client.waitForJob(jobId, { timeout: 5000 })

        expect(job).toBeTruthy()
        expect(job?.id).toBe(jobId)
        expect(job?.status).toBe(JOB_STATUS_FAILED)
        expect(job?.error).toBeTruthy()
      })

      it('should return immediately if job is already completed', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Already done',
        })

        // Process the job first
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Now wait for it - should return immediately
        const job = await client.waitForJob(jobId)

        expect(job).toBeTruthy()
        expect(job?.id).toBe(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)
      })

      it('should timeout if job does not complete in time', async () => {
        const jobId = await client.runAction('slowAction', {})

        // Don't fetch/process the job - it will never complete
        const job = await client.waitForJob(jobId, { timeout: 100 })

        expect(job).toBeNull()
      })

      it('should handle abort signal', async () => {
        const jobId = await client.runAction('slowAction', {})
        const controller = new AbortController()

        // Start waiting
        const waitPromise = client.waitForJob(jobId, { signal: controller.signal })

        // Abort after a short delay
        setTimeout(() => {
          controller.abort()
        }, 50)

        const job = await waitPromise

        expect(job).toBeNull()
      })

      it('should handle multiple concurrent waitForJob calls for the same job', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Multiple waits',
        })

        // Start multiple waits
        const wait1 = client.waitForJob(jobId, { timeout: 5000 })
        const wait2 = client.waitForJob(jobId, { timeout: 5000 })
        const wait3 = client.waitForJob(jobId, { timeout: 5000 })

        // Start processing
        client.fetch({ batchSize: 10 })

        // All should resolve to the same job
        const [job1, job2, job3] = await Promise.all([wait1, wait2, wait3])

        expect(job1).toBeTruthy()
        expect(job2).toBeTruthy()
        expect(job3).toBeTruthy()
        expect(job1?.id).toBe(jobId)
        expect(job2?.id).toBe(jobId)
        expect(job3?.id).toBe(jobId)
        expect(job1?.status).toBe(JOB_STATUS_COMPLETED)
        expect(job2?.status).toBe(JOB_STATUS_COMPLETED)
        expect(job3?.status).toBe(JOB_STATUS_COMPLETED)
      })

      it('should handle multiple waitForJob calls for different jobs', async () => {
        const jobId1 = await client.runAction('testAction', {
          message: 'Job 1',
        })
        const jobId2 = await client.runAction('testAction', {
          message: 'Job 2',
        })

        // Start waiting for both
        const wait1 = client.waitForJob(jobId1, { timeout: 5000 })
        const wait2 = client.waitForJob(jobId2, { timeout: 5000 })

        // Start processing
        client.fetch({ batchSize: 10 })

        // Both should resolve
        const [job1, job2] = await Promise.all([wait1, wait2])

        expect(job1).toBeTruthy()
        expect(job2).toBeTruthy()
        expect(job1?.id).toBe(jobId1)
        expect(job2?.id).toBe(jobId2)
        expect(job1?.status).toBe(JOB_STATUS_COMPLETED)
        expect(job2?.status).toBe(JOB_STATUS_COMPLETED)
      })
    })

    describe('Concurrency Limits', () => {
      beforeEach(async () => {
        await client.start()
      })

      it('should respect group concurrency limits', async () => {
        const actionWithConcurrency = defineAction()({
          name: 'concurrency-action',
          input: z.object({
            group: z.string(),
          }),
          output: z.object({ result: z.string() }),
          groups: {
            groupKey: async (ctx) => ctx.input.group,
            concurrency: async () => 2,
          },
          handler: async (ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 100))
            return { result: ctx.input.group }
          },
        })

        const databaseInstance = await adapterFactory.create()

        const concurrencyClient = new Client({
          id: 'concurrency-client',
          database: databaseInstance.adapter,
          actions: {
            concurrencyAction: actionWithConcurrency,
          },
          syncPattern: false,
          logger: 'error',
        })

        await concurrencyClient.start()

        // Create 3 jobs in the same group with limit of 2
        await concurrencyClient.runAction('concurrencyAction', { group: 'group-1' })
        await concurrencyClient.runAction('concurrencyAction', { group: 'group-1' })
        await concurrencyClient.runAction('concurrencyAction', { group: 'group-1' })

        const fetchedJobs = await concurrencyClient.fetch({ batchSize: 10 })

        // Should only fetch 2 jobs due to concurrency limit
        const group1Jobs = fetchedJobs.filter((job) => job.groupKey === 'group-1')
        expect(group1Jobs.length).toEqual(2)

        await concurrencyClient.stop()
      })
    })

    describe('Variables', () => {
      it('should make variables available to actions', async () => {
        const actionWithVars = defineAction()({
          name: 'vars-action',
          input: z.object({}),
          output: z.object({ result: z.string() }),
          handler: async (ctx) => {
            const apiKey = (ctx.var as any).apiKey
            return { result: `API Key: ${apiKey}` }
          },
        })

        const varsClient = new Client({
          database,
          actions: {
            varsAction: actionWithVars,
          },
          variables: {
            apiKey: 'secret-key-123',
          },
          syncPattern: false,
          logger: 'error',
        })

        await varsClient.start()

        const jobId = await varsClient.runAction('varsAction', {})

        await varsClient.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const job = await varsClient.getJobById(jobId)
        expect(job?.output).toEqual({ result: 'API Key: secret-key-123' })

        await varsClient.stop()
      })
    })
  })
}

runClientTests(postgresFactory)
runClientTests(pgliteFactory)
