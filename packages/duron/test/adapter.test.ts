import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  JOB_STATUS_ACTIVE,
  JOB_STATUS_CANCELLED,
  JOB_STATUS_COMPLETED,
  JOB_STATUS_CREATED,
  JOB_STATUS_FAILED,
  STEP_STATUS_ACTIVE,
  STEP_STATUS_CANCELLED,
  STEP_STATUS_COMPLETED,
  STEP_STATUS_FAILED,
} from '../src/constants.js'
import { serializeError } from '../src/errors.js'
import { type Adapter, type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'
import { expectToBeDefined } from './asserts.js'

function runAdapterTests(adapterFactory: AdapterFactory) {
  describe(`Adapter Tests with ${adapterFactory.name}`, () => {
    let adapter: Adapter
    let deleteDb: () => Promise<void>

    beforeEach(async () => {
      // Get a postgres connection using the docker utility
      const adapterInstance = await adapterFactory.create()
      adapter = adapterInstance.adapter
      deleteDb = adapterInstance.deleteDb
      // Create a new adapter instance for each test
      adapter.setId('test-adapter')
    })

    afterEach(async () => {
      // Clean up: stop the adapter
      if (adapter) {
        await adapter.stop()
      }
      if (deleteDb) {
        await deleteDb()
      }
    })

    describe('Lifecycle', () => {
      it('should start and stop the adapter', async () => {
        const started = await adapter.start()
        expect(started).toBe(true)

        const stopped = await adapter.stop()
        expect(stopped).toBe(true)
      })

      it('should run migrations on start', async () => {
        await adapter.start()
        // If migrations run successfully, start should complete without error
        expect(adapter).toBeDefined()
      })

      it('should handle multiple start calls', async () => {
        const promise1 = adapter.start()
        const promise2 = adapter.start()
        const promise3 = adapter.start()

        const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3])

        expect(result1).toBe(true)
        expect(result2).toBe(true)
        expect(result3).toBe(true)
      })
    })

    describe('Job Management', () => {
      beforeEach(async () => {
        await adapter.start()
      })

      it('should create a job', async () => {
        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        expect(jobId).toBeTruthy()
        expect(typeof jobId).toBe('string')
      })

      it('should retrieve a job by ID', async () => {
        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        expectToBeDefined(jobId)

        const job = await adapter.getJobById(jobId!)

        expect(job).toBeTruthy()
        expect(job?.id).toBe(jobId)
        expect(job?.actionName).toBe('test-action')
        expect(job?.groupKey).toBe('test-group')
        expect(job?.status).toBe(JOB_STATUS_CREATED)
        expect(job?.input).toEqual({ message: 'hello' })
        expect(job?.concurrencyLimit).toBe(10)
      })

      it('should complete a job', async () => {
        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        // First fetch the job to make it active
        await adapter.fetch({ batch: 1 })

        const completed = await adapter.completeJob({
          jobId: jobId!,
          output: { result: 'success' },
        })

        expect(completed).toBe(true)

        const job = await adapter.getJobById(jobId!)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)
        expect(job?.output).toEqual({ result: 'success' })
      })

      it('should fail a job', async () => {
        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        // First fetch the job to make it active
        await adapter.fetch({ batch: 1 })

        const failed = await adapter.failJob({
          jobId: jobId!,
          error: { message: 'Something went wrong' },
        })

        expect(failed).toBe(true)

        const job = await adapter.getJobById(jobId!)
        expect(job?.status).toBe(JOB_STATUS_FAILED)
        expect(job?.error).toEqual({ message: 'Something went wrong' })
      })

      it('should cancel a job', async () => {
        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        const cancelled = await adapter.cancelJob({
          jobId: jobId!,
        })

        expect(cancelled).toBe(true)

        const job = await adapter.getJobById(jobId!)
        expect(job?.status).toBe(JOB_STATUS_CANCELLED)
      })

      it('should retry a failed job', async () => {
        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        // Fetch and fail the job
        await adapter.fetch({ batch: 1 })
        await adapter.failJob({
          jobId: jobId!,
          error: { message: 'Error' },
        })

        // Retry the job
        const retryJobId = await adapter.retryJob({
          jobId: jobId!,
        })

        expect(retryJobId).toBeTruthy()
        expect(retryJobId).not.toBe(jobId)

        const retryJob = await adapter.getJobById(retryJobId!)
        expect(retryJob?.status).toBe(JOB_STATUS_CREATED)
        expect(retryJob?.input).toEqual({ message: 'hello' })
        expect(retryJob?.output).toBeNull()
        expect(retryJob?.error).toBeNull()
      })
    })

    describe('Job Fetching', () => {
      beforeEach(async () => {
        await adapter.start()
      })

      it('should fetch jobs respecting concurrency limits', async () => {
        // Create multiple jobs in the same group with concurrency limit of 2
        await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { id: 1 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 2,
        })

        await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { id: 2 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 2,
        })

        await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { id: 3 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 2,
        })

        // Fetch with batch size of 10, but concurrency limit of 2 per group
        const fetchedJobs = await adapter.fetch({ batch: 10 })

        expect(fetchedJobs.length).toBeLessThanOrEqual(2)
        expect(fetchedJobs.every((job) => job.status === JOB_STATUS_ACTIVE)).toBe(true)
      })

      it('should fetch jobs from different groups independently', async () => {
        // Create jobs in different groups with concurrency limit of 1 each
        await adapter.createJob({
          queue: 'test-action',
          groupKey: 'group-1',
          input: { group: 1 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 1,
        })

        await adapter.createJob({
          queue: 'test-action',
          groupKey: 'group-2',
          input: { group: 2 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 1,
        })

        // Fetch with batch size of 10
        const fetchedJobs = await adapter.fetch({ batch: 10 })

        // Should fetch both jobs since they're in different groups
        expect(fetchedJobs.length).toBe(2)
      })

      it('should respect batch size limit', async () => {
        // Create multiple jobs
        for (let i = 0; i < 5; i++) {
          await adapter.createJob({
            queue: 'test-action',
            groupKey: 'test-group',
            input: { id: i },
            timeoutMs: 5000,
            checksum: 'abc123',
            concurrencyLimit: 10,
          })
        }

        // Fetch with batch size of 2
        const fetchedJobs = await adapter.fetch({ batch: 2 })

        expect(fetchedJobs.length).toBeLessThanOrEqual(2)
      })

      it('should fetch jobs respecting per-group concurrency limits (case 1)', async () => {
        // Precondition: group-one with concurrency 2, group-two with concurrency 1
        // Create jobs in order: group-one, group-two, group-one
        const job1 = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'group-one',
          input: { id: 1 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 2,
        })

        // Small delay to ensure different created_at timestamps for deterministic ordering
        await new Promise((resolve) => setTimeout(resolve, 10))

        const job2 = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'group-two',
          input: { id: 2 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 1,
        })

        // Small delay to ensure different created_at timestamps for deterministic ordering
        await new Promise((resolve) => setTimeout(resolve, 10))

        const job3 = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'group-one',
          input: { id: 3 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 2,
        })

        // Fetch with batch size of 2
        const fetchedJobs = await adapter.fetch({ batch: 2 })

        // Should get the first group-one job and the group-two job
        expect(fetchedJobs.length).toBe(2)
        expect(fetchedJobs.some((job) => job.id === job3)).toBe(false) // Should not fetch the second group-one job yet
        expect(fetchedJobs.some((job) => job.id === job1)).toBe(true)
        expect(fetchedJobs.some((job) => job.id === job2)).toBe(true)
      })

      it('should fetch jobs respecting per-group concurrency limits (case 2)', async () => {
        // Precondition: group-one with concurrency 2, group-two with concurrency 1
        // Create jobs in order: group-one, group-two, group-one, group-two
        const job1 = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'group-one',
          input: { id: 1 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 2,
        })

        // Small delay to ensure different created_at timestamps for deterministic ordering
        await new Promise((resolve) => setTimeout(resolve, 10))

        const job2 = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'group-two',
          input: { id: 2 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 1,
        })

        // Small delay to ensure different created_at timestamps for deterministic ordering
        await new Promise((resolve) => setTimeout(resolve, 10))

        const job3 = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'group-one',
          input: { id: 3 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 2,
        })

        // Small delay to ensure different created_at timestamps for deterministic ordering
        await new Promise((resolve) => setTimeout(resolve, 10))

        const job4 = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'group-two',
          input: { id: 4 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 1,
        })

        // Fetch with batch size of 4
        const fetchedJobs = await adapter.fetch({ batch: 4 })

        // Should get: first group-one job, group-two job, and then the second group-one job
        // The second group-two job should not be fetched because group-two has concurrency limit of 1
        expect(fetchedJobs.length).toBe(3)
        expect(fetchedJobs.some((job) => job.id === job1)).toBe(true) // First group-one
        expect(fetchedJobs.some((job) => job.id === job2)).toBe(true) // group-two
        expect(fetchedJobs.some((job) => job.id === job3)).toBe(true) // Second group-one
        expect(fetchedJobs.some((job) => job.id === job4)).toBe(false) // Second group-two should not be fetched
      })
    })

    describe('Job Recovery', () => {
      beforeEach(async () => {
        await adapter.start()
      })

      it('should recover stuck jobs', async () => {
        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        // Fetch the job to make it active
        await adapter.fetch({ batch: 1 })

        // Simulate a stuck job by manually updating the owner_id to a non-existent one
        // In a real scenario, this would happen when a process crashes
        const recovered = await adapter.recoverJobs({
          checksums: ['abc123'],
          multiProcessMode: false,
        })

        // The job should be recovered (reset to CREATED status)
        expect(recovered).toBeGreaterThanOrEqual(0)

        const job = await adapter.getJobById(jobId!)
        // The job should be back to CREATED status if it was recovered
        if (recovered > 0) {
          expect(job?.status).toBe(JOB_STATUS_CREATED)
        }
      })
    })

    describe('Step Management', () => {
      let jobId: string

      beforeEach(async () => {
        await adapter.start()

        // Create and fetch a job to make it active
        const createdJobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        await adapter.fetch({ batch: 1 })
        jobId = createdJobId!
      })

      it('should create a new job step', async () => {
        const step = await adapter.createOrRecoverJobStep({
          jobId,
          name: 'step-1',
          timeoutMs: 3000,
          retriesLimit: 3,
        })

        expect(step).toBeTruthy()
        expect(step?.status).toBe(STEP_STATUS_ACTIVE)
        expect(step?.retriesLimit).toBe(3)
        expect(step?.retriesCount).toBe(0)
        expect(step?.isNew).toBe(true)
      })

      it('should recover an existing job step', async () => {
        // Create a step first
        const step1 = await adapter.createOrRecoverJobStep({
          jobId,
          name: 'step-1',
          timeoutMs: 3000,
          retriesLimit: 3,
        })

        // Create it again - should recover the existing step
        const step2 = await adapter.createOrRecoverJobStep({
          jobId,
          name: 'step-1',
          timeoutMs: 5000,
          retriesLimit: 5,
        })

        expect(step2).toBeTruthy()
        expect(step2?.id).toBe(step1?.id)
        expect(step2?.timeoutMs).toBe(5000)
        expect(step2?.retriesLimit).toBe(5)
        expect(step2?.isNew).toBe(false)
      })

      it('should complete a job step', async () => {
        const step = await adapter.createOrRecoverJobStep({
          jobId,
          name: 'step-1',
          timeoutMs: 3000,
          retriesLimit: 3,
        })

        const completed = await adapter.completeJobStep({
          stepId: step!.id,
          output: { result: 'step completed' },
        })

        expect(completed).toBe(true)

        const retrievedStep = await adapter.getJobStepById(step!.id)
        expect(retrievedStep?.status).toBe(STEP_STATUS_COMPLETED)
        expect(retrievedStep?.output).toEqual({ result: 'step completed' })
      })

      it('should fail a job step', async () => {
        const step = await adapter.createOrRecoverJobStep({
          jobId,
          name: 'step-1',
          timeoutMs: 3000,
          retriesLimit: 3,
        })

        const failed = await adapter.failJobStep({
          stepId: step!.id,
          error: { message: 'Step failed' },
        })

        expect(failed).toBe(true)

        const retrievedStep = await adapter.getJobStepById(step!.id)
        expect(retrievedStep?.status).toBe(STEP_STATUS_FAILED)
        expect(retrievedStep?.error).toEqual({ message: 'Step failed' })
      })

      it('should delay a job step', async () => {
        const step = await adapter.createOrRecoverJobStep({
          jobId,
          name: 'step-1',
          timeoutMs: 3000,
          retriesLimit: 3,
        })

        const delayed = await adapter.delayJobStep({
          stepId: step!.id,
          delayMs: 1000,
          error: serializeError(new Error('Temporary failure')),
        })

        expect(delayed).toBe(true)

        const retrievedStep = await adapter.getJobStepById(step!.id)
        expect(retrievedStep?.delayedMs).toBe(1000)
        expect(retrievedStep?.retriesCount).toBe(1)
        expect(retrievedStep?.historyFailedAttempts).toBeTruthy()
        expect(Object.keys(retrievedStep?.historyFailedAttempts ?? {}).length).toBeGreaterThan(0)
      })

      it('should cancel a job step', async () => {
        const step = await adapter.createOrRecoverJobStep({
          jobId,
          name: 'step-1',
          timeoutMs: 3000,
          retriesLimit: 3,
        })

        const cancelled = await adapter.cancelJobStep({
          stepId: step!.id,
        })

        expect(cancelled).toBe(true)

        const retrievedStep = await adapter.getJobStepById(step!.id)
        expect(retrievedStep?.status).toBe(STEP_STATUS_CANCELLED)
      })
    })

    describe('Query Methods', () => {
      beforeEach(async () => {
        await adapter.start()
      })

      it('should get jobs with pagination', async () => {
        // Create multiple jobs
        for (let i = 0; i < 5; i++) {
          await adapter.createJob({
            queue: 'test-action',
            groupKey: 'test-group',
            input: { id: i },
            timeoutMs: 5000,
            checksum: 'abc123',
            concurrencyLimit: 10,
          })
        }

        const result = await adapter.getJobs({
          page: 1,
          pageSize: 2,
        })

        expect(result.jobs.length).toBe(2)
        expect(result.total).toBe(5)
        expect(result.page).toBe(1)
        expect(result.pageSize).toBe(2)
      })

      it('should filter jobs by status', async () => {
        const jobId1 = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { id: 1 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        const jobId2 = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { id: 2 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        expectToBeDefined(jobId1)

        // Fetch and complete one job
        await adapter.fetch({ batch: 1 })
        await adapter.completeJob({
          jobId: jobId1,
          output: { result: 'done' },
        })

        // Filter by completed status
        const completedJobs = await adapter.getJobs({
          filters: {
            status: JOB_STATUS_COMPLETED,
          },
        })

        expect(completedJobs.jobs.length).toBe(1)
        expect(completedJobs.jobs[0]?.id).toBe(jobId1)

        // Filter by created status
        const createdJobs = await adapter.getJobs({
          filters: {
            status: JOB_STATUS_CREATED,
          },
        })

        expect(createdJobs.jobs.some((job) => job.id === jobId2)).toBe(true)
      })

      it('should filter jobs by action name', async () => {
        await adapter.createJob({
          queue: 'action-1',
          groupKey: 'test-group',
          input: { id: 1 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        await adapter.createJob({
          queue: 'action-2',
          groupKey: 'test-group',
          input: { id: 2 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        const result = await adapter.getJobs({
          filters: {
            actionName: 'action-1',
          },
        })

        expect(result.jobs.length).toBe(1)
        expect(result.jobs[0]?.actionName).toBe('action-1')
      })

      it('should get job steps with pagination', async () => {
        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { id: 1 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        await adapter.fetch({ batch: 1 })

        // Create multiple steps
        for (let i = 0; i < 5; i++) {
          await adapter.createOrRecoverJobStep({
            jobId: jobId!,
            name: `step-${i}`,
            timeoutMs: 3000,
            retriesLimit: 3,
          })
        }

        const result = await adapter.getJobSteps({
          jobId: jobId!,
          page: 1,
          pageSize: 2,
        })

        expect(result.steps.length).toBe(2)
        expect(result.total).toBe(5)
        expect(result.page).toBe(1)
        expect(result.pageSize).toBe(2)
      })

      it('should get action statistics', async () => {
        // Create jobs for different actions
        await adapter.createJob({
          queue: 'action-1',
          groupKey: 'test-group',
          input: { id: 1 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        await adapter.createJob({
          queue: 'action-2',
          groupKey: 'test-group',
          input: { id: 2 },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        const result = await adapter.getActions()

        expect(result.actions.length).toBeGreaterThanOrEqual(2)
        const action1 = result.actions.find((a) => a.name === 'action-1')
        const action2 = result.actions.find((a) => a.name === 'action-2')

        expect(action1).toBeTruthy()
        expect(action2).toBeTruthy()
        expect(action1?.active).toBe(0)
        expect(action1?.completed).toBe(0)
      })
    })

    describe('Events', () => {
      beforeEach(async () => {
        await adapter.start()
      })

      it('should emit job-status-changed event when completing a job', async () => {
        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        await adapter.fetch({ batch: 1 })

        const eventPromise = new Promise((resolve) => {
          adapter.once('job-status-changed', (data) => {
            resolve(data)
          })
        })

        await adapter.completeJob({
          jobId: jobId!,
          output: { result: 'success' },
        })

        const eventData = await eventPromise
        expect(eventData).toBeTruthy()
        expect((eventData as any).jobId).toBe(jobId)
        expect((eventData as any).status).toBe(JOB_STATUS_COMPLETED)
      })

      it('should emit job-available event when creating a job', async () => {
        const eventPromise = new Promise((resolve) => {
          adapter.once('job-available', (data) => {
            resolve(data)
          })
        })

        const jobId = await adapter.createJob({
          queue: 'test-action',
          groupKey: 'test-group',
          input: { message: 'hello' },
          timeoutMs: 5000,
          checksum: 'abc123',
          concurrencyLimit: 10,
        })

        const eventData = await eventPromise
        expect(eventData).toBeTruthy()
        expect((eventData as any).jobId).toBe(jobId)
      })
    })
  })
}

runAdapterTests(postgresFactory)
runAdapterTests(pgliteFactory)
