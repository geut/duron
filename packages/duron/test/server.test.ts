import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { defineAction } from '../src/action.js'
import { ActionStatsSchema, JobSchema, JobStepSchema } from '../src/adapters/schemas.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_CANCELLED, JOB_STATUS_COMPLETED, JOB_STATUS_CREATED, JOB_STATUS_FAILED } from '../src/constants.js'
import {
  CancelJobResponseSchema,
  createServer,
  ErrorResponseSchema,
  GetActionsResponseSchema,
  GetJobStepsResponseSchema,
  GetJobsResponseSchema,
  RetryJobResponseSchema,
} from '../src/server.js'
import { type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'
import { expectToBeDefined } from './asserts.js'

// Helper schemas for JSON responses (dates come as strings in JSON)
const JobResponseSchema = JobSchema.extend({
  expiresAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const JobStepResponseSchema = JobStepSchema.extend({
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const JobStepWithoutOutputResponseSchema = JobStepSchema.omit({ output: true }).extend({
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const GetJobStepsResponseParsedSchema = GetJobStepsResponseSchema.extend({
  steps: z.array(JobStepWithoutOutputResponseSchema),
})

const GetJobsResponseParsedSchema = GetJobsResponseSchema.extend({
  jobs: z.array(JobResponseSchema),
})

const ActionStatsResponseSchema = ActionStatsSchema.extend({
  lastJobCreated: z.string().nullable(),
})

const GetActionsResponseParsedSchema = GetActionsResponseSchema.extend({
  actions: z.array(ActionStatsResponseSchema),
})

type JobResponse = z.infer<typeof JobResponseSchema>
type JobStepResponse = z.infer<typeof JobStepResponseSchema>
type GetJobStepsResponse = z.infer<typeof GetJobStepsResponseParsedSchema>
type GetJobsResponse = z.infer<typeof GetJobsResponseParsedSchema>
type GetActionsResponse = z.infer<typeof GetActionsResponseParsedSchema>
type ErrorResponse = z.infer<typeof ErrorResponseSchema>
type CancelJobResponse = z.infer<typeof CancelJobResponseSchema>
type RetryJobResponse = z.infer<typeof RetryJobResponseSchema>

function runServerTests(adapterFactory: AdapterFactory) {
  describe(`Server Tests with ${adapterFactory.name}`, () => {
    let client: Client<any, any>
    let server: ReturnType<typeof createServer>
    let deleteDb: () => Promise<void>

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
          result: `Processed: ${ctx.input.message}`,
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

    beforeEach(
      async () => {
        const adapterInstance = await adapterFactory.create({})
        deleteDb = adapterInstance.deleteDb

        client = new Client({
          database: adapterInstance.adapter,
          actions: {
            testAction,
            failingAction,
          },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
        })

        await client.start()

        server = createServer({
          client,
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

    describe('GET /api/jobs/:id', () => {
      it('should get a job by ID', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Server test',
          value: 42,
        })

        const response = await server.handle(new Request(`http://localhost/api/jobs/${jobId}`))
        expect(response.status).toBe(200)

        const job = JobResponseSchema.parse(await response.json()) as JobResponse

        expect(job.id).toBe(jobId)
        expect(job.actionName).toBe('test-action')
        expect(job.status).toBe(JOB_STATUS_CREATED)
        expect(job.input).toEqual({ message: 'Server test', value: 42 })
      })

      it('should return 404 for non-existent job', async () => {
        const response = await server.handle(
          new Request('http://localhost/api/jobs/123e4567-e89b-12d3-a456-426614174000'),
        )
        expect(response.status).toBe(404)

        const error = ErrorResponseSchema.parse(await response.json()) as ErrorResponse
        expect(error.error).toBe('Not found')
      })
    })

    describe('GET /api/jobs/:id/steps', () => {
      it('should get job steps', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Get steps',
        })

        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const response = await server.handle(new Request(`http://localhost/api/jobs/${jobId}/steps`))
        expect(response.status).toBe(200)

        const result = GetJobStepsResponseParsedSchema.parse(await response.json()) as GetJobStepsResponse

        expect(result.steps).toBeInstanceOf(Array)
        expect(result.total).toBeGreaterThan(0)
        expect(result.page).toBe(1)
        expect(result.pageSize).toBeGreaterThan(0)
      })

      it('should paginate job steps', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Paginated steps',
        })

        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const response = await server.handle(new Request(`http://localhost/api/jobs/${jobId}/steps?page=1&pageSize=1`))
        expect(response.status).toBe(200)

        const result = GetJobStepsResponseParsedSchema.parse(await response.json()) as GetJobStepsResponse

        expect(result.steps.length).toBeLessThanOrEqual(1)
        expect(result.page).toBe(1)
        expect(result.pageSize).toBe(1)
      })

      it('should filter steps by search query', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Search steps',
        })

        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const response = await server.handle(new Request(`http://localhost/api/jobs/${jobId}/steps?search=step-1`))
        expect(response.status).toBe(200)

        const result = GetJobStepsResponseParsedSchema.parse(await response.json()) as GetJobStepsResponse

        expect(result.steps.length).toBeGreaterThan(0)
        expect(result.steps.some((step) => step.name.includes('step-1'))).toBe(true)
      })
    })

    describe('GET /api/jobs', () => {
      it('should get jobs with pagination', async () => {
        // Create multiple jobs
        for (let i = 0; i < 5; i++) {
          await client.runAction('testAction', {
            message: `Job ${i}`,
          })
        }

        const response = await server.handle(new Request('http://localhost/api/jobs?page=1&pageSize=2'))
        expect(response.status).toBe(200)

        const result = GetJobsResponseParsedSchema.parse(await response.json()) as GetJobsResponse

        expect(result.jobs.length).toBe(2)
        expect(result.total).toBe(5)
        expect(result.page).toBe(1)
        expect(result.pageSize).toBe(2)
      })

      it('should filter jobs by status', async () => {
        const jobId1 = await client.runAction('testAction', {
          message: 'Job 1',
        })

        await client.runAction('testAction', {
          message: 'Job 2',
        })

        // Process first job
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const response = await server.handle(new Request(`http://localhost/api/jobs?fStatus=${JOB_STATUS_COMPLETED}`))
        expect(response.status).toBe(200)

        const result = GetJobsResponseParsedSchema.parse(await response.json()) as GetJobsResponse

        expect(result.jobs.length).toBeGreaterThan(0)
        expect(result.jobs.some((job) => job.id === jobId1)).toBe(true)
      })

      it('should filter jobs by action name', async () => {
        await client.runAction('testAction', {
          message: 'Test action',
        })

        await client.runAction('failingAction', {
          shouldFail: false,
        })

        const response = await server.handle(new Request('http://localhost/api/jobs?fActionName=test-action'))
        expect(response.status).toBe(200)

        const result = GetJobsResponseParsedSchema.parse(await response.json()) as GetJobsResponse

        expect(result.jobs.length).toBeGreaterThan(0)
        expect(result.jobs.every((job) => job.actionName === 'test-action')).toBe(true)
      })

      it('should filter jobs by multiple statuses', async () => {
        await client.runAction('testAction', {
          message: 'Job 1',
        })

        await client.runAction('testAction', {
          message: 'Job 2',
        })

        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const response = await server.handle(
          new Request(`http://localhost/api/jobs?fStatus=${JOB_STATUS_COMPLETED}&fStatus=${JOB_STATUS_CREATED}`),
        )
        expect(response.status).toBe(200)

        const result = GetJobsResponseParsedSchema.parse(await response.json()) as GetJobsResponse

        expect(result.jobs.length).toBeGreaterThan(0)
      })

      it('should sort jobs', async () => {
        // Create jobs with delays to ensure different timestamps
        await client.runAction('testAction', { message: 'First' })
        await new Promise((resolve) => setTimeout(resolve, 10))
        await client.runAction('testAction', { message: 'Second' })
        await new Promise((resolve) => setTimeout(resolve, 10))
        await client.runAction('testAction', { message: 'Third' })

        const response = await server.handle(new Request('http://localhost/api/jobs?sort=createdAt:desc'))
        expect(response.status).toBe(200)

        const result = GetJobsResponseParsedSchema.parse(await response.json()) as GetJobsResponse

        expect(result.jobs.length).toBeGreaterThan(0)
        // Jobs should be in descending order by createdAt
        for (let i = 0; i < result.jobs.length - 1; i++) {
          const current = new Date(result.jobs[i]!.createdAt)
          const next = new Date(result.jobs[i + 1]!.createdAt)
          expect(current.getTime()).toBeGreaterThanOrEqual(next.getTime())
        }
      })

      it('should filter jobs by date range', async () => {
        const beforeDate = new Date()
        await new Promise((resolve) => setTimeout(resolve, 2000))

        await client.runAction('testAction', {
          message: 'Date filtered',
        })

        await new Promise((resolve) => setTimeout(resolve, 1000))
        const afterDate = new Date()

        const response = await server.handle(
          new Request(`http://localhost/api/jobs?fCreatedAt=${beforeDate.toISOString()},${afterDate.toISOString()}`),
        )
        expect(response.status).toBe(200)

        const result = GetJobsResponseParsedSchema.parse(await response.json()) as GetJobsResponse

        expect(result.jobs.length).toBeGreaterThan(0)
      })
    })

    describe('GET /api/steps/:id', () => {
      it('should get a step by ID', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Get step',
        })

        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Get steps first to find a step ID
        const stepsResponse = await server.handle(new Request(`http://localhost/api/jobs/${jobId}/steps`))
        const stepsResult = GetJobStepsResponseParsedSchema.parse(await stepsResponse.json()) as GetJobStepsResponse

        expectToBeDefined(stepsResult.steps[0])

        const stepId = stepsResult.steps[0]!.id

        const response = await server.handle(new Request(`http://localhost/api/steps/${stepId}`))
        expect(response.status).toBe(200)

        const step = JobStepResponseSchema.parse(await response.json()) as JobStepResponse

        expect(step.id).toBe(stepId)
        expect(step.jobId).toBe(jobId)
        expect(step.name).toBe('step-1')
      })

      it('should return 404 for non-existent step', async () => {
        const response = await server.handle(
          new Request('http://localhost/api/steps/123e4567-e89b-12d3-a456-426614174000'),
        )
        expect(response.status).toBe(404)

        const error = ErrorResponseSchema.parse(await response.json()) as ErrorResponse
        expect(error.error).toBe('Not found')
      })
    })

    describe('POST /api/jobs/:id/cancel', () => {
      it('should cancel a job', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Cancel me',
        })

        const response = await server.handle(
          new Request(`http://localhost/api/jobs/${jobId}/cancel`, {
            method: 'POST',
          }),
        )

        expect(response.status).toBe(200)

        const result = CancelJobResponseSchema.parse(await response.json()) as CancelJobResponse

        expect(result.success).toBe(true)
        expect(result.message).toContain(jobId)

        // Verify job is cancelled
        const jobResponse = await server.handle(new Request(`http://localhost/api/jobs/${jobId}`))
        const job = JobResponseSchema.parse(await jobResponse.json()) as JobResponse

        expect(job.status).toBe(JOB_STATUS_CANCELLED)
      })

      it('should handle cancelling non-existent job', async () => {
        const response = await server.handle(
          new Request('http://localhost/api/jobs/123e4567-e89b-12d3-a456-426614174000/cancel', {
            method: 'POST',
          }),
        )

        // Should still return success (idempotent operation)
        expect(response.status).toBe(200)
      })
    })

    describe('POST /api/jobs/:id/retry', () => {
      it('should retry a failed job', async () => {
        const jobId = await client.runAction('failingAction', {
          shouldFail: true,
        })

        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Verify job failed
        const jobBefore = await client.getJobById(jobId)
        expect(jobBefore?.status).toBe(JOB_STATUS_FAILED)

        const response = await server.handle(
          new Request(`http://localhost/api/jobs/${jobId}/retry`, {
            method: 'POST',
          }),
        )

        expect(response.status).toBe(200)

        const result = RetryJobResponseSchema.parse(await response.json()) as RetryJobResponse

        expect(result.success).toBe(true)
        expect(result.newJobId).toBeTruthy()
        expect(result.newJobId).not.toBe(jobId)

        // Verify new job was created
        const newJobResponse = await server.handle(new Request(`http://localhost/api/jobs/${result.newJobId}`))
        const newJob = JobResponseSchema.parse(await newJobResponse.json()) as JobResponse

        expect(newJob.status).toBe(JOB_STATUS_CREATED)
        expect(newJob.input).toEqual({ shouldFail: true })
      })

      it('should return error for non-retryable job', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Not failed',
        })

        const response = await server.handle(
          new Request(`http://localhost/api/jobs/${jobId}/retry`, {
            method: 'POST',
          }),
        )

        // Should return error since job is not in failed state
        expect(response.status).toBe(500)

        const error = ErrorResponseSchema.parse(await response.json()) as ErrorResponse
        expect(error.error).toBe('Internal server error')
      })
    })

    describe('GET /api/actions', () => {
      it('should get action statistics', async () => {
        await client.runAction('testAction', {
          message: 'Stats',
        })

        await client.runAction('failingAction', {
          shouldFail: false,
        })

        const response = await server.handle(new Request('http://localhost/api/actions'))
        expect(response.status).toBe(200)

        const result = GetActionsResponseParsedSchema.parse(await response.json()) as GetActionsResponse

        expect(result.actions).toBeInstanceOf(Array)
        expect(result.actions.length).toBeGreaterThanOrEqual(2)

        const testActionStats = result.actions.find((a) => a.name === 'test-action')
        const failingActionStats = result.actions.find((a) => a.name === 'failing-action')

        expect(testActionStats).toBeTruthy()
        expect(failingActionStats).toBeTruthy()
        expect(testActionStats!.active).toBeGreaterThanOrEqual(0)
        expect(testActionStats!.completed).toBeGreaterThanOrEqual(0)
      })
    })

    describe('Error Handling', () => {
      it('should handle validation errors', async () => {
        const response = await server.handle(new Request('http://localhost/api/jobs?page=invalid'))
        expect(response.status).toBe(400)
      })

      it('should handle invalid query parameters', async () => {
        const response = await server.handle(new Request('http://localhost/api/jobs?pageSize=10000')) // Exceeds max
        expect(response.status).toBe(400)
      })
    })

    describe('Client-Server Integration', () => {
      it('should create job via client and query via server', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Client-Server integration',
          value: 123,
        })

        const response = await server.handle(new Request(`http://localhost/api/jobs/${jobId}`))
        const job = JobResponseSchema.parse(await response.json()) as JobResponse

        expect(job.id).toBe(jobId)
        expect(job.input).toEqual({ message: 'Client-Server integration', value: 123 })
      })

      it('should process job via client and check status via server', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Process and check',
        })

        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const response = await server.handle(new Request(`http://localhost/api/jobs/${jobId}`))
        const job = JobResponseSchema.parse(await response.json()) as JobResponse

        expect(job.status).toBe(JOB_STATUS_COMPLETED)
        expect(job.output).toEqual({ result: 'Processed: Process and check' })
      })

      it('should cancel job via server and verify via client', async () => {
        const jobId = await client.runAction('testAction', {
          message: 'Cancel via server',
        })

        await server.handle(
          new Request(`http://localhost/api/jobs/${jobId}/cancel`, {
            method: 'POST',
          }),
        )

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_CANCELLED)
      })

      it('should retry job via server and process via client', async () => {
        const jobId = await client.runAction('failingAction', {
          shouldFail: true,
        })

        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const retryResponse = await server.handle(
          new Request(`http://localhost/api/jobs/${jobId}/retry`, {
            method: 'POST',
          }),
        )
        const retryResult = RetryJobResponseSchema.parse(await retryResponse.json()) as RetryJobResponse

        const newJobId = retryResult.newJobId

        // Process the retried job
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const newJob = await client.getJobById(newJobId)
        // The retried job should still fail since shouldFail is true
        expect(newJob?.status).toBe(JOB_STATUS_FAILED)
      })
    })
  })
}

runServerTests(postgresFactory)
runServerTests(pgliteFactory)
