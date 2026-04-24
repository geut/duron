import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  JOB_STATUS_ACTIVE,
  JOB_STATUS_CANCELLED,
  JOB_STATUS_COMPLETED,
  JOB_STATUS_CREATED,
  JOB_STATUS_FAILED,
} from '../src/constants.js'
import { type Adapter, type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'
import { expectToBeDefined } from './asserts.js'

function runArchiveTests(adapterFactory: AdapterFactory) {
  describe(`Archive Tests with ${adapterFactory.name}`, () => {
    let adapter: Adapter
    let deleteDb: () => Promise<void>

    beforeEach(
      async () => {
        const adapterInstance = await adapterFactory.create()
        adapter = adapterInstance.adapter
        deleteDb = adapterInstance.deleteDb
        adapter.setId('test-adapter')
        await adapter.start()
      },
      {
        timeout: 60_000,
      },
    )

    afterEach(async () => {
      if (adapter) {
        await adapter.stop()
      }
      if (deleteDb) {
        await deleteDb()
      }
    })

    it('should archive completed job and query it', async () => {
      const jobId = await adapter.createJob({
        queue: 'test-action',
        groupKey: 'test-group',
        input: { value: 42 },
        timeoutMs: 10000,
        checksum: 'abc123',
        concurrencyLimit: 10,
        concurrencyStepLimit: 10,
      })
      expectToBeDefined(jobId)

      // Fetch to activate
      const fetched = await adapter.fetch({ batch: 10 })
      expect(fetched.length).toBe(1)
      expect(fetched[0]?.status).toBe(JOB_STATUS_ACTIVE)

      // Complete the job
      const completed = await adapter.completeJob({ jobId, output: { result: 'done' } })
      expect(completed).toBe(true)

      // Should find in archive via getJobById
      const job = await adapter.getJobById(jobId)
      expectToBeDefined(job)
      expect(job.status).toBe(JOB_STATUS_COMPLETED)
      expect(job.output).toEqual({ result: 'done' })
    })

    it('should archive failed job', async () => {
      const jobId = await adapter.createJob({
        queue: 'test-action',
        groupKey: 'test-group',
        input: {},
        timeoutMs: 10000,
        checksum: 'abc123',
        concurrencyLimit: 10,
        concurrencyStepLimit: 10,
      })
      expectToBeDefined(jobId)

      const fetched = await adapter.fetch({ batch: 10 })
      expect(fetched.length).toBe(1)

      const failed = await adapter.failJob({
        jobId,
        error: { name: 'Error', message: 'Test failure', stack: '' },
      })
      expect(failed).toBe(true)

      const job = await adapter.getJobById(jobId)
      expectToBeDefined(job)
      expect(job.status).toBe(JOB_STATUS_FAILED)
    })

    it('should archive cancelled job', async () => {
      const jobId = await adapter.createJob({
        queue: 'test-action',
        groupKey: 'test-group',
        input: {},
        timeoutMs: 10000,
        checksum: 'abc123',
        concurrencyLimit: 10,
        concurrencyStepLimit: 10,
      })
      expectToBeDefined(jobId)

      const cancelled = await adapter.cancelJob({ jobId })
      expect(cancelled).toBe(true)

      const job = await adapter.getJobById(jobId)
      expectToBeDefined(job)
      expect(job.status).toBe(JOB_STATUS_CANCELLED)
    })

    it('should get archive stats', async () => {
      // Create and complete 2 jobs
      for (let i = 0; i < 2; i++) {
        const jobId = await adapter.createJob({
          queue: `test-action-${i}`,
          groupKey: 'test-group',
          input: {},
          timeoutMs: 10000,
          checksum: `abc${i}`,
          concurrencyLimit: 10,
          concurrencyStepLimit: 10,
        })
        expectToBeDefined(jobId)

        const fetched = await adapter.fetch({ batch: 10 })
        expect(fetched.length).toBeGreaterThan(0)

        await adapter.completeJob({ jobId, output: {} })
      }

      const stats = await adapter.getArchiveStats()
      expect(stats.jobsCount).toBe(2)
      expect(stats.oldestJobDate).not.toBeNull()
    })

    it('should prune old jobs', async () => {
      const jobId = await adapter.createJob({
        queue: 'test-action',
        groupKey: 'test-group',
        input: {},
        timeoutMs: 10000,
        checksum: 'abc123',
        concurrencyLimit: 10,
        concurrencyStepLimit: 10,
      })
      expectToBeDefined(jobId)

      const fetched = await adapter.fetch({ batch: 10 })
      expect(fetched.length).toBeGreaterThan(0)

      await adapter.completeJob({ jobId, output: {} })

      // Verify in archive
      let stats = await adapter.getArchiveStats()
      expect(stats.jobsCount).toBe(1)

      // Wait a tiny bit
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Prune with old threshold
      const deleted = await adapter.pruneArchive({
        olderThan: '1ms',
        batchSize: 100,
        maxBatches: 1,
      })
      expect(deleted).toBe(1)

      stats = await adapter.getArchiveStats()
      expect(stats.jobsCount).toBe(0)
    })

    it('should not prune recent jobs', async () => {
      const jobId = await adapter.createJob({
        queue: 'test-action',
        groupKey: 'test-group',
        input: {},
        timeoutMs: 10000,
        checksum: 'abc123',
        concurrencyLimit: 10,
        concurrencyStepLimit: 10,
      })
      expectToBeDefined(jobId)

      const fetched = await adapter.fetch({ batch: 10 })
      expect(fetched.length).toBeGreaterThan(0)

      await adapter.completeJob({ jobId, output: {} })

      const deleted = await adapter.pruneArchive({
        olderThan: '7d',
        batchSize: 100,
        maxBatches: 1,
      })
      expect(deleted).toBe(0)

      const stats = await adapter.getArchiveStats()
      expect(stats.jobsCount).toBe(1)
    })

    it('should truncate archive', async () => {
      for (let i = 0; i < 3; i++) {
        const jobId = await adapter.createJob({
          queue: `test-action-${i}`,
          groupKey: 'test-group',
          input: {},
          timeoutMs: 10000,
          checksum: `abc${i}`,
          concurrencyLimit: 10,
          concurrencyStepLimit: 10,
        })
        expectToBeDefined(jobId)

        const fetched = await adapter.fetch({ batch: 10 })
        expect(fetched.length).toBeGreaterThan(0)

        await adapter.completeJob({ jobId, output: {} })
      }

      let stats = await adapter.getArchiveStats()
      expect(stats.jobsCount).toBe(3)

      await adapter.truncateArchive()

      stats = await adapter.getArchiveStats()
      expect(stats.jobsCount).toBe(0)
      expect(stats.stepsCount).toBe(0)
      expect(stats.spansCount).toBe(0)
    })

    it('should query archived job by status filter', async () => {
      const activeJobId = await adapter.createJob({
        queue: 'test-action',
        groupKey: 'test-group',
        input: {},
        timeoutMs: 10000,
        checksum: 'active',
        concurrencyLimit: 10,
        concurrencyStepLimit: 10,
      })
      expectToBeDefined(activeJobId)

      const completedJobId = await adapter.createJob({
        queue: 'test-action',
        groupKey: 'test-group',
        input: {},
        timeoutMs: 10000,
        checksum: 'completed',
        concurrencyLimit: 10,
        concurrencyStepLimit: 10,
      })
      expectToBeDefined(completedJobId)

      const fetched = await adapter.fetch({ batch: 10 })
      expect(fetched.length).toBe(2)

      await adapter.completeJob({ jobId: completedJobId, output: {} })

      const activeJobs = await adapter.getJobs({
        filters: { status: JOB_STATUS_ACTIVE },
      })
      expect(activeJobs.jobs.length).toBe(1)
      expect(activeJobs.jobs[0]?.id).toBe(activeJobId)

      const completedJobs = await adapter.getJobs({
        filters: { status: JOB_STATUS_COMPLETED },
      })
      expect(completedJobs.jobs.length).toBe(1)
      expect(completedJobs.jobs[0]?.id).toBe(completedJobId)
    })

    it('should restore archived job for time travel', async () => {
      const jobId = await adapter.createJob({
        queue: 'test-action',
        groupKey: 'test-group',
        input: {},
        timeoutMs: 10000,
        checksum: 'abc123',
        concurrencyLimit: 10,
        concurrencyStepLimit: 10,
      })
      expectToBeDefined(jobId)

      const fetched = await adapter.fetch({ batch: 10 })
      expect(fetched.length).toBeGreaterThan(0)

      const step = await adapter.createOrRecoverJobStep({
        jobId,
        name: 'test-step',
        timeoutMs: 10000,
        retriesLimit: 0,
      })
      expectToBeDefined(step)

      await adapter.completeJobStep({
        stepId: step.id,
        output: { done: true },
      })

      await adapter.completeJob({ jobId, output: { result: 'done' } })

      // Verify archived
      let job = await adapter.getJobById(jobId)
      expect(job?.status).toBe(JOB_STATUS_COMPLETED)

      // Time travel
      const success = await adapter.timeTravelJob({ jobId, stepId: step.id })
      expect(success).toBe(true)

      // Should be restored
      job = await adapter.getJobById(jobId)
      expectToBeDefined(job)
      expect(job.status).toBe(JOB_STATUS_CREATED)
    })
  })
}

runArchiveTests(pgliteFactory)
runArchiveTests(postgresFactory)
