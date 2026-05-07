import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import {
  JOB_STATUS_ACTIVE,
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
        const result = await client.waitForJob(jobId, { timeout: 5000 })

        expect(result).toBeTruthy()
        expect(result?.id).toBe(jobId)
        expect(result?.status).toBe(JOB_STATUS_COMPLETED)
        expect(result?.output).toEqual({ result: 'Processed: Wait for me' })
      })

      it('should wait for a job to fail', async () => {
        const jobId = await client.runAction('failingAction', {
          shouldFail: true,
        })

        // Start processing in the background
        client.fetch({ batchSize: 10 })

        // Wait for the job to fail
        const result = await client.waitForJob(jobId, { timeout: 5000 })

        expect(result).toBeTruthy()
        expect(result?.id).toBe(jobId)
        expect(result?.status).toBe(JOB_STATUS_FAILED)
        expect(result?.error).toBeTruthy()
      })

      it('should return immediately if job is already completed', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Already done',
        })

        // Process the job first
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Now wait for it - should return immediately
        const result = await client.waitForJob(jobId)

        expect(result).toBeTruthy()
        expect(result?.id).toBe(jobId)
        expect(result?.status).toBe(JOB_STATUS_COMPLETED)
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

        // All should resolve to the same job result
        const [result1, result2, result3] = await Promise.all([wait1, wait2, wait3])

        expect(result1).toBeTruthy()
        expect(result2).toBeTruthy()
        expect(result3).toBeTruthy()
        expect(result1?.id).toBe(jobId)
        expect(result2?.id).toBe(jobId)
        expect(result3?.id).toBe(jobId)
        expect(result1?.status).toBe(JOB_STATUS_COMPLETED)
        expect(result2?.status).toBe(JOB_STATUS_COMPLETED)
        expect(result3?.status).toBe(JOB_STATUS_COMPLETED)
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
        const [result1, result2] = await Promise.all([wait1, wait2])

        expect(result1).toBeTruthy()
        expect(result2).toBeTruthy()
        expect(result1?.id).toBe(jobId1)
        expect(result2?.id).toBe(jobId2)
        expect(result1?.status).toBe(JOB_STATUS_COMPLETED)
        expect(result2?.status).toBe(JOB_STATUS_COMPLETED)
      })
    })

    describe('runActionAndWait', () => {
      beforeEach(async () => {
        await client.start()
      })

      it('should run an action and wait for completion', async () => {
        // Use a client with auto-fetch enabled
        const autoClient = new Client({
          database,
          actions: {
            testAction,
            failingAction,
            slowAction,
            slowStepAction,
          },
          syncPattern: 'hybrid',
          pullInterval: 100,
          logger: 'error',
        })

        await autoClient.start()

        const result = await autoClient.runActionAndWait('testAction', {
          message: 'Wait for result',
        })

        expect(result).toBeTruthy()
        expect(result.id).toBeTruthy()
        expect(result.actionName).toBe('test-action')
        expect(result.status).toBe(JOB_STATUS_COMPLETED)
        expect(result.groupKey).toBe('@default')
        expect(result.output).toEqual({ result: 'Processed: Wait for result' })
        expect(result.error).toBeNull()

        await autoClient.stop()
      })

      it('should return typed input and output', async () => {
        // Use a client with auto-fetch enabled
        const autoClient = new Client({
          database,
          actions: {
            testAction,
            failingAction,
            slowAction,
            slowStepAction,
          },
          syncPattern: 'hybrid',
          pullInterval: 100,
          logger: 'error',
        })

        await autoClient.start()

        const result = await autoClient.runActionAndWait('testAction', {
          message: 'Type check test',
          value: 123,
        })

        // TypeScript should infer these types correctly
        const message: string = result.input.message
        const value: number | undefined = result.input.value
        const output: string = result.output.result

        expect(message).toBe('Type check test')
        expect(value).toBe(123)
        expect(output).toBe('Processed: Type check test')

        await autoClient.stop()
      })

      it('should throw when action fails', async () => {
        // Use a client with auto-fetch enabled
        const autoClient = new Client({
          database,
          actions: {
            testAction,
            failingAction,
            slowAction,
            slowStepAction,
          },
          syncPattern: 'hybrid',
          pullInterval: 100,
          logger: 'error',
        })

        await autoClient.start()

        try {
          await autoClient.runActionAndWait('failingAction', {
            shouldFail: true,
          })
          expect(true).toBe(false) // Should not reach here
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toBe('Action failed intentionally')
        }

        await autoClient.stop()
      })

      it('should abort operation when signal is aborted', async () => {
        // Use a client with auto-fetch disabled so job doesn't complete
        const controller = new AbortController()

        // Abort quickly
        setTimeout(() => controller.abort(), 50)

        try {
          await client.runActionAndWait(
            'slowAction',
            {},
            {
              signal: controller.signal,
            },
          )
          expect(true).toBe(false) // Should not reach here
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toBe('Operation was aborted')
        }
      })

      it('should timeout operation when timeout is reached', async () => {
        // Use a client with auto-fetch disabled so job doesn't complete
        try {
          await client.runActionAndWait(
            'slowAction',
            {},
            {
              timeout: 50,
            },
          )
          expect(true).toBe(false) // Should not reach here
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toBe('Operation timed out')
        }
      })

      it('should throw immediately if signal is already aborted', async () => {
        const controller = new AbortController()
        controller.abort()

        try {
          await client.runActionAndWait(
            'testAction',
            { message: 'test' },
            {
              signal: controller.signal,
            },
          )
          expect(true).toBe(false) // Should not reach here
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toBe('Operation was aborted')
        }
      })

      it('should cancel the job when aborted', async () => {
        // Use a client with auto-fetch enabled so the job starts processing
        const autoClient = new Client({
          database,
          actions: {
            testAction,
            failingAction,
            slowAction,
            slowStepAction,
          },
          syncPattern: 'hybrid',
          pullInterval: 100,
          logger: 'error',
        })

        await autoClient.start()

        const controller = new AbortController()

        // Start the slow action
        const waitPromise = autoClient.runActionAndWait(
          'slowStepAction',
          {},
          {
            signal: controller.signal,
          },
        )

        // Wait a bit then abort
        await new Promise((resolve) => setTimeout(resolve, 50))
        controller.abort()

        try {
          await waitPromise
          expect(true).toBe(false) // Should not reach here
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toBe('Operation was aborted')
        }

        // Wait a bit for the cancellation to be processed
        await new Promise((resolve) => setTimeout(resolve, 200))

        await autoClient.stop()
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

      it('should recover expired orphan jobs from dead processes and allow new jobs to proceed', async () => {
        // This test simulates a multi-process scenario where:
        // 1. Instance A processes a job and then crashes
        // 2. The job remains active in the database (orphan job)
        // 3. Instance B (with multiProcessMode enabled) detects the orphan
        //    via periodic recovery in fetch()
        // 4. The expired orphan is archived as failed, freeing up the
        //    concurrency slot for new jobs
        //
        // We simulate the crashed instance by setting the job's client_id
        // to a fake process ID that won't respond to pings.

        const actionWithConcurrency = defineAction()({
          name: 'expired-concurrency-action',
          input: z.object({
            group: z.string(),
          }),
          output: z.object({ result: z.string() }),
          groups: {
            groupKey: async (ctx) => ctx.input.group,
            concurrency: async () => 1,
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
            expiredConcurrencyAction: actionWithConcurrency,
          },
          syncPattern: false,
          multiProcessMode: true,
          recoverJobsInterval: 1,
          processTimeout: 500,
          logger: 'error',
        })

        await concurrencyClient.start()

        // Create a job
        const jobId1 = await concurrencyClient.runAction('expiredConcurrencyAction', { group: 'group-1' })

        // Fetch it to make it active
        const fetchedJobs1 = await concurrencyClient.fetch({ batchSize: 10 })
        expect(fetchedJobs1.length).toBe(1)
        expect(fetchedJobs1[0]!.id).toBe(jobId1)

        // Verify it's active
        const job1 = await concurrencyClient.getJobById(jobId1)
        expectToBeDefined(job1)
        expect(job1.status).toBe(JOB_STATUS_ACTIVE)

        // Manually expire the job by setting expires_at to the past
        const adapter = databaseInstance.adapter as any
        await adapter.db.execute(
          `UPDATE jobs_active SET expires_at = NOW() - INTERVAL '1 minute', client_id = 'concurrency-client-2' WHERE id = '${jobId1}'`,
        )

        // Create another job for the same group
        const jobId2 = await concurrencyClient.runAction('expiredConcurrencyAction', { group: 'group-1' })

        // Fetch again - should get the new job because the first one is expired
        const fetchedJobs2 = await concurrencyClient.fetch({ batchSize: 10 })

        expect(fetchedJobs2.length).toBe(1)
        expect(fetchedJobs2[0]!.id).toBe(jobId2)

        // Manually trigger recovery to archive the expired job
        await databaseInstance.adapter.recoverJobs({
          checksums: [actionWithConcurrency.checksum],
        })

        // Verify the first job was archived as failed
        const expiredJob = await concurrencyClient.getJobById(jobId1)
        expectToBeDefined(expiredJob)
        expect(expiredJob.status).toBe(JOB_STATUS_FAILED)
        expect(expiredJob.error).toBeTruthy()

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

    describe('Job Description', () => {
      it('should store dynamic description in job', async () => {
        const actionWithDescription = defineAction()({
          name: 'described-action',
          input: z.object({
            a: z.number(),
            b: z.number(),
          }),
          output: z.object({ sum: z.number() }),
          description: async (ctx) => `Calculate ${ctx.input.a} + ${ctx.input.b}`,
          handler: async (ctx) => {
            return { sum: ctx.input.a + ctx.input.b }
          },
        })

        const descClient = new Client({
          database,
          actions: {
            describedAction: actionWithDescription,
          },
          syncPattern: false,
          logger: 'error',
        })

        await descClient.start()

        const jobId = await descClient.runAction('describedAction', { a: 5, b: 3 })

        const job = await descClient.getJobById(jobId)
        expect(job?.description).toBe('Calculate 5 + 3')

        await descClient.stop()
      })

      it('should have null description when not defined', async () => {
        const actionWithoutDescription = defineAction()({
          name: 'no-description-action',
          input: z.object({ value: z.number() }),
          output: z.object({ result: z.number() }),
          handler: async (ctx) => {
            return { result: ctx.input.value * 2 }
          },
        })

        const noDescClient = new Client({
          database,
          actions: {
            noDescAction: actionWithoutDescription,
          },
          syncPattern: false,
          logger: 'error',
        })

        await noDescClient.start()

        const jobId = await noDescClient.runAction('noDescAction', { value: 10 })

        const job = await noDescClient.getJobById(jobId)
        expect(job?.description).toBeNull()

        await noDescClient.stop()
      })

      it('should include description in waitForJob result', async () => {
        const actionWithDesc = defineAction()({
          name: 'wait-desc-action',
          input: z.object({ name: z.string() }),
          output: z.object({ greeting: z.string() }),
          description: async (ctx) => `Greeting ${ctx.input.name}`,
          handler: async (ctx) => {
            return { greeting: `Hello, ${ctx.input.name}!` }
          },
        })

        const waitClient = new Client({
          database,
          actions: {
            waitDescAction: actionWithDesc,
          },
          syncPattern: 'hybrid',
          pullInterval: 100,
          logger: 'error',
        })

        await waitClient.start()

        const jobId = await waitClient.runAction('waitDescAction', { name: 'World' })
        const result = await waitClient.waitForJob(jobId, { timeout: 5000 })

        expect(result?.description).toBe('Greeting World')
        expect(result?.status).toBe(JOB_STATUS_COMPLETED)

        await waitClient.stop()
      })

      it('should filter jobs by description', async () => {
        const actionWithDesc = defineAction()({
          name: 'filter-desc-action',
          input: z.object({ email: z.string() }),
          output: z.object({ sent: z.boolean() }),
          description: async (ctx) => `Send email to ${ctx.input.email}`,
          handler: async () => {
            return { sent: true }
          },
        })

        const filterClient = new Client({
          database,
          actions: {
            filterDescAction: actionWithDesc,
          },
          syncPattern: false,
          logger: 'error',
        })

        await filterClient.start()

        await filterClient.runAction('filterDescAction', { email: 'user1@test.com' })
        await filterClient.runAction('filterDescAction', { email: 'user2@test.com' })
        await filterClient.runAction('filterDescAction', { email: 'admin@test.com' })

        // Filter by description containing 'user'
        const result = await filterClient.getJobs({
          filters: { description: 'user' },
        })

        expect(result.jobs.length).toBe(2)
        expect(result.jobs.every((job) => job.description?.includes('user'))).toBe(true)

        await filterClient.stop()
      })
    })
  })
}

runClientTests(postgresFactory)
// biome-ignore lint/complexity/useLiteralKeys: type safety
if (process.env['POSTGRES_TEST'] === 'true') {
  runClientTests(pgliteFactory)
}
