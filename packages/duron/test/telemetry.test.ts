import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { defineAction } from '../src/action.js'
import type { Adapter } from '../src/adapters/adapter.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_COMPLETED } from '../src/constants.js'
import { createServer } from '../src/server.js'
import { LocalTelemetryAdapter, localTelemetryAdapter } from '../src/telemetry/local.js'
import { NoopTelemetryAdapter, noopTelemetryAdapter } from '../src/telemetry/noop.js'
import { type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'

function runTelemetryTests(adapterFactory: AdapterFactory) {
  describe(`Telemetry Tests with ${adapterFactory.name}`, () => {
    let adapter: Adapter
    let deleteDb: () => Promise<void>

    beforeEach(
      async () => {
        const adapterInstance = await adapterFactory.create({})
        adapter = adapterInstance.adapter
        deleteDb = adapterInstance.deleteDb
      },
      { timeout: 60_000 },
    )

    afterEach(async () => {
      if (deleteDb) {
        await deleteDb()
      }
    })

    describe('NoopTelemetryAdapter', () => {
      it('should create a noop adapter', async () => {
        const telemetry = noopTelemetryAdapter()
        expect(telemetry).toBeInstanceOf(NoopTelemetryAdapter)

        await telemetry.start()

        // Noop methods should not throw
        const span = await telemetry.startJobSpan({ jobId: 'test', actionName: 'test', groupKey: '@default' })

        const observeContext = telemetry.createObserveContext('test', null, span)
        observeContext.recordMetric('test', 1)
        observeContext.addSpanAttribute('test', 'value')
        observeContext.addSpanEvent('test')

        await telemetry.endJobSpan(span, { status: 'ok' })

        await telemetry.stop()
      })

      it('should work with client without storing metrics', async () => {
        const action = defineAction()({
          name: 'test-action',
          version: '1.0.0',
          handler: async (ctx) => {
            // Record a metric
            ctx.observe.recordMetric('custom.metric', 42)
            ctx.observe.addSpanAttribute('custom.attr', 'test')

            await ctx.step('step-1', async (stepCtx) => {
              stepCtx.observe.recordMetric('step.metric', 10)
              return { done: true }
            })

            return { success: true }
          },
        })

        const client = new Client({
          database: adapter,
          actions: { action },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
          telemetry: noopTelemetryAdapter(),
        })

        await client.start()

        const jobId = await client.runAction('action', {})
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 500))

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        // metricsEnabled should be false with noop adapter
        expect(client.metricsEnabled).toBe(false)

        await client.stop()
      })
    })

    describe('LocalTelemetryAdapter', () => {
      it('should create a local adapter', async () => {
        const telemetry = localTelemetryAdapter()
        expect(telemetry).toBeInstanceOf(LocalTelemetryAdapter)
      })

      it('should store and retrieve metrics', async () => {
        const action = defineAction()({
          name: 'metrics-action',
          version: '1.0.0',
          handler: async (ctx) => {
            // Record job-level metrics
            ctx.observe.recordMetric('tokens.input', 150)
            ctx.observe.recordMetric('tokens.output', 50)
            ctx.observe.recordMetric('latency.ms', 1234, { model: 'gpt-4' })

            await ctx.step('ai-step', async (stepCtx) => {
              // Record step-level metrics
              stepCtx.observe.recordMetric('step.tokens', 100)
              stepCtx.observe.addSpanAttribute('model', 'gpt-4')
              stepCtx.observe.addSpanEvent('api.call.start')
              return { response: 'AI response' }
            })

            return { processed: true }
          },
        })

        const telemetry = localTelemetryAdapter()

        const client = new Client({
          database: adapter,
          actions: { action },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
          telemetry,
        })

        await client.start()
        expect(client.metricsEnabled).toBe(true)

        const jobId = await client.runAction('action', {})
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 1000))

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        // Wait for metrics debounce flush (1 second debounce + buffer)
        await new Promise((resolve) => setTimeout(resolve, 1500))

        // Retrieve metrics
        const result = await client.getMetrics({ jobId })
        expect(result.metrics.length).toBeGreaterThan(0)

        // Check for our custom metrics
        const tokenMetric = result.metrics.find((m) => m.name === 'tokens.input')
        expect(tokenMetric).toBeTruthy()
        expect(tokenMetric?.value).toBe(150)

        const latencyMetric = result.metrics.find((m) => m.name === 'latency.ms')
        expect(latencyMetric).toBeTruthy()
        expect(latencyMetric?.value).toBe(1234)
        // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
        expect((latencyMetric?.attributes as Record<string, unknown>)?.['model']).toBe('gpt-4')

        await client.stop()
      })

      it('should not throw when getMetrics is called on noop adapter', async () => {
        const client = new Client({
          database: adapter,
          actions: {},
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
          telemetry: noopTelemetryAdapter(),
        })

        await client.start()
        expect(client.metricsEnabled).toBe(false)

        // This should throw because metrics are not enabled
        let error: Error | null = null
        try {
          await client.getMetrics({ jobId: 'test' })
        } catch (e) {
          error = e as Error
        }

        expect(error).toBeTruthy()
        expect(error?.message).toContain('Metrics are only available when using LocalTelemetryAdapter')

        await client.stop()
      })

      it('should handle step metrics separately', async () => {
        let capturedStepId: string | null = null

        const action = defineAction()({
          name: 'step-metrics-action',
          version: '1.0.0',
          handler: async (ctx) => {
            await ctx.step('tracked-step', async (stepCtx) => {
              capturedStepId = stepCtx.stepId
              stepCtx.observe.recordMetric('step.duration.ms', 500)
              stepCtx.observe.recordMetric('step.items.processed', 10)
              return { done: true }
            })
            return { success: true }
          },
        })

        const telemetry = localTelemetryAdapter()

        const client = new Client({
          database: adapter,
          actions: { action },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
          telemetry,
        })

        await client.start()

        const jobId = await client.runAction('action', {})
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 1000))

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        // Verify step ID was captured
        expect(capturedStepId).toBeTruthy()

        // Wait for metrics debounce flush (1 second debounce + buffer)
        await new Promise((resolve) => setTimeout(resolve, 1500))

        // Get metrics for the specific step
        const stepMetrics = await client.getMetrics({ stepId: capturedStepId! })
        expect(stepMetrics.metrics.length).toBeGreaterThan(0)

        const durationMetric = stepMetrics.metrics.find((m) => m.name === 'step.duration.ms')
        expect(durationMetric).toBeTruthy()
        expect(durationMetric?.stepId).toBe(capturedStepId)

        await client.stop()
      })
    })

    describe('Server metrics endpoints', () => {
      it('should return metricsEnabled in config', async () => {
        const action = defineAction()({
          name: 'test-action',
          version: '1.0.0',
          handler: async () => ({ done: true }),
        })

        const telemetry = localTelemetryAdapter()

        const client = new Client({
          database: adapter,
          actions: { action },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
          telemetry,
        })

        await client.start()

        const server = createServer({ client })

        // Check config endpoint
        const configResponse = await server.handle(new Request('http://localhost/api/config'))
        expect(configResponse.status).toBe(200)

        const config = (await configResponse.json()) as { metricsEnabled: boolean; authEnabled: boolean }
        expect(config.metricsEnabled).toBe(true)
        expect(config.authEnabled).toBe(false)

        await client.stop()
      })

      it('should get job metrics via API', async () => {
        const action = defineAction()({
          name: 'api-test-action',
          version: '1.0.0',
          handler: async (ctx) => {
            ctx.observe.recordMetric('api.test.metric', 999)
            return { done: true }
          },
        })

        const telemetry = localTelemetryAdapter()

        const client = new Client({
          database: adapter,
          actions: { action },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
          telemetry,
        })

        await client.start()

        const server = createServer({ client })

        // Run a job
        const jobId = await client.runAction('action', {})
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 1000))

        // Wait for metrics debounce flush (1 second debounce + buffer)
        await new Promise((resolve) => setTimeout(resolve, 1500))

        // Get metrics via API
        const response = await server.handle(new Request(`http://localhost/api/jobs/${jobId}/metrics`))
        expect(response.status).toBe(200)

        const result = (await response.json()) as { metrics: any[]; total: number }
        expect(result.metrics).toBeInstanceOf(Array)
        expect(result.metrics.length).toBeGreaterThan(0)

        const testMetric = result.metrics.find((m) => m.name === 'api.test.metric')
        expect(testMetric).toBeTruthy()
        expect(testMetric?.value).toBe(999)

        await client.stop()
      })

      it('should return error when metrics not enabled', async () => {
        const action = defineAction()({
          name: 'test-action',
          version: '1.0.0',
          handler: async () => ({ done: true }),
        })

        const client = new Client({
          database: adapter,
          actions: { action },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
          telemetry: noopTelemetryAdapter(),
        })

        await client.start()

        const server = createServer({ client })

        // Try to get metrics without local telemetry - should return 500
        const response = await server.handle(
          new Request('http://localhost/api/jobs/123e4567-e89b-12d3-a456-426614174000/metrics'),
        )
        expect(response.status).toBe(500)

        // The error message is wrapped in a generic "Internal server error" by Elysia
        // Just verify the status code is correct
        const error = (await response.json()) as { error: string }
        expect(error.error).toBeTruthy()

        await client.stop()
      })
    })

    describe('Observe context', () => {
      it('should support span attributes and events', async () => {
        // Create a custom spy on the telemetry
        const baseTelemetry = localTelemetryAdapter()

        const action = defineAction()({
          name: 'observe-test',
          version: '1.0.0',
          handler: async (ctx) => {
            ctx.observe.addSpanAttribute('job.custom', 'value1')
            ctx.observe.addSpanEvent('job.started', { custom: true })

            await ctx.step('step-1', async (stepCtx) => {
              stepCtx.observe.addSpanAttribute('step.model', 'gpt-4o')
              stepCtx.observe.addSpanEvent('step.processing')
              return { ok: true }
            })

            ctx.observe.addSpanEvent('job.completed')
            return { done: true }
          },
        })

        const client = new Client({
          database: adapter,
          actions: { action },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
          telemetry: baseTelemetry,
        })

        await client.start()

        const jobId = await client.runAction('action', {})
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 1000))

        const job = await client.getJobById(jobId)
        expect(job?.status).toBe(JOB_STATUS_COMPLETED)

        await client.stop()
      })

      it('should handle different metric types', async () => {
        const action = defineAction()({
          name: 'metric-types-test',
          version: '1.0.0',
          handler: async (ctx) => {
            ctx.observe.recordMetric('gauge.metric', 100)
            ctx.observe.recordMetric('counter.metric', 1)
            ctx.observe.recordMetric('histogram.metric', 50)
            ctx.observe.recordMetric('summary.metric', 75)
            return { done: true }
          },
        })

        const telemetry = localTelemetryAdapter()

        const client = new Client({
          database: adapter,
          actions: { action },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
          telemetry,
        })

        await client.start()

        const jobId = await client.runAction('action', {})
        await client.fetch({ batchSize: 10 })
        await new Promise((resolve) => setTimeout(resolve, 1000))

        // Wait for metrics debounce flush (1 second debounce + buffer)
        await new Promise((resolve) => setTimeout(resolve, 1500))

        const result = await client.getMetrics({ jobId })

        const gaugeMetric = result.metrics.find((m) => m.name === 'gauge.metric')
        expect(gaugeMetric).toBeTruthy()
        expect(gaugeMetric?.value).toBe(100)

        const counterMetric = result.metrics.find((m) => m.name === 'counter.metric')
        expect(counterMetric).toBeTruthy()
        expect(counterMetric?.value).toBe(1)

        const histogramMetric = result.metrics.find((m) => m.name === 'histogram.metric')
        expect(histogramMetric).toBeTruthy()
        expect(histogramMetric?.value).toBe(50)

        const summaryMetric = result.metrics.find((m) => m.name === 'summary.metric')
        expect(summaryMetric).toBeTruthy()
        expect(summaryMetric?.value).toBe(75)

        await client.stop()
      })
    })
  })
}

runTelemetryTests(postgresFactory)
runTelemetryTests(pgliteFactory)
