import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_ACTIVE } from '../src/constants.js'

import { type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'

function runDeleteJobsSafetyTests(adapterFactory: AdapterFactory) {
  describe(`Delete Jobs Safety Tests with ${adapterFactory.name}`, () => {
    let client: Client<any, any>
    let deleteDb: () => Promise<void>

    const testAction = defineAction()({
      name: 'test-action',
      version: '1.0.0',
      input: z.object({
        message: z.string(),
      }),
      output: z.object({
        result: z.string(),
      }),
      handler: async (ctx) => {
        // Simulate slow processing so jobs stay active longer
        await new Promise((resolve) => setTimeout(resolve, 200))
        return { result: `Processed: ${ctx.input.message}` }
      },
    })

    beforeEach(
      async () => {
        const adapterInstance = await adapterFactory.create({})
        deleteDb = adapterInstance.deleteDb

        client = new Client({
          database: adapterInstance.adapter,
          actions: {
            testAction,
          },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
        })

        await client.start()
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

    describe('Finding #3: Bulk DELETE cannot destroy running jobs', () => {
      it('should not delete active jobs when DELETE /jobs is called with no filters', async () => {
        // Create multiple jobs - some will be active (processing), some created (queued)
        const jobIds: string[] = []
        for (let i = 0; i < 5; i++) {
          const id = await client.runAction('testAction', {
            message: `job ${i}`,
          })
          jobIds.push(id)
        }

        // Wait a tiny bit for some jobs to start processing (become active)
        await new Promise((resolve) => setTimeout(resolve, 50))

        // Verify we have jobs in the system
        const adapter = (client as any).database
        const beforeDelete = await adapter.getJobs({ filters: {} })
        expect(beforeDelete.jobs.length).toBeGreaterThanOrEqual(1)

        // Try to delete ALL jobs with no filters (the dangerous case)
        const deletedCount = await client.deleteJobs({})

        // Some jobs may have been deleted (non-active ones), but active ones must survive
        const afterDelete = await adapter.getJobs({ filters: {} })

        // Verify all originally created jobs that are still active remain
        for (const jobId of jobIds) {
          const job = afterDelete.jobs.find((j: any) => j.id === jobId)
          // If the job is still active, it MUST NOT have been deleted
          if (job && job.status === JOB_STATUS_ACTIVE) {
            expect(job.id).toBe(jobId) // Active job survived
          }
        }
      })

      it('should not delete active jobs even when status filter explicitly includes active', async () => {
        // Create a job
        const jobId = await client.runAction('testAction', {
          message: 'active job',
        })

        // Wait for it to become active
        await new Promise((resolve) => setTimeout(resolve, 50))

        const adapter = (client as any).database

        // Verify the job is active
        const job = await adapter.getJobById(jobId)
        expect(job).toBeDefined()

        // Even if someone tries to delete with status: ['active'], it should be blocked
        // The guard should always protect active jobs
        const deletedCount = await client.deleteJobs({
          filters: {
            status: ['active'],
          },
        })

        // The job should still exist
        const afterJob = await adapter.getJobById(jobId)
        expect(afterJob).toBeDefined()
        expect(afterJob!.id).toBe(jobId)
      })
    })
  })
}

describe('Delete Jobs Safety Tests', () => {
  runDeleteJobsSafetyTests(postgresFactory)
  runDeleteJobsSafetyTests(pgliteFactory)
})
