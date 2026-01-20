import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { defineAction } from '../src/action.js'
import type { Adapter } from '../src/adapters/adapter.js'
import { Client } from '../src/client.js'
import { type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'

function runSpansTests(adapterFactory: AdapterFactory) {
  describe(`OpenTelemetry Integration with ${adapterFactory.name}`, () => {
    let duron: Client<any, any>
    let database: Adapter
    let deleteDb: () => Promise<void>

    beforeEach(async () => {
      const adapterInstance = await adapterFactory.create()
      database = adapterInstance.adapter
      deleteDb = adapterInstance.deleteDb
    })

    afterEach(async () => {
      if (duron) {
        await duron.stop()
      }
      await deleteDb()
    })

    describe('TelemetryContext in handlers', () => {
      it('should provide telemetry context with OpenTelemetry APIs', async () => {
        let actionTelemetryContext: any = null
        let stepTelemetryContext: any = null

        const action = defineAction()({
          name: 'telemetry-context-test',
          handler: async (ctx) => {
            actionTelemetryContext = ctx.telemetry

            await ctx.step('test-step', async (stepCtx) => {
              stepTelemetryContext = stepCtx.telemetry
              return { result: 'step-result' }
            })

            return { result: 'done' }
          },
        })

        duron = new Client({
          id: 'test-telemetry-context',
          database,
          actions: { action },
          logger: 'silent',
          telemetry: {
            local: true,
          },
        })

        await duron.start()
        await duron.runActionAndWait('action', {})
        await duron.stop()

        // Verify action telemetry context has OTel APIs
        expect(actionTelemetryContext).toBeDefined()
        expect(typeof actionTelemetryContext.getActiveSpan).toBe('function')
        expect(typeof actionTelemetryContext.getTracer).toBe('function')
        expect(typeof actionTelemetryContext.recordMetric).toBe('function')

        // Verify step telemetry context has OTel APIs
        expect(stepTelemetryContext).toBeDefined()
        expect(typeof stepTelemetryContext.getActiveSpan).toBe('function')
        expect(typeof stepTelemetryContext.getTracer).toBe('function')
        expect(typeof stepTelemetryContext.recordMetric).toBe('function')
      })

      it('should allow recording custom metrics via recordMetric', async () => {
        const action = defineAction()({
          name: 'record-metric-test',
          handler: async (ctx) => {
            ctx.telemetry.recordMetric('custom.tokens.input', 150)
            ctx.telemetry.recordMetric('custom.tokens.output', 50, { model: 'gpt-4' })

            await ctx.step('llm-call', async (stepCtx) => {
              stepCtx.telemetry.recordMetric('step.latency.ms', 234)
              return { result: 'result' }
            })

            return { result: 'done' }
          },
        })

        duron = new Client({
          id: 'test-record-metric',
          database,
          actions: { action },
          logger: 'silent',
          telemetry: {
            local: { flushDelayMs: 10 }, // Very short delay for tests
          },
        })

        await duron.start()
        const job = await duron.runActionAndWait('action', {})

        // Wait a bit for spans to be flushed by BatchSpanProcessor
        await new Promise((resolve) => setTimeout(resolve, 50))

        // Query spans BEFORE stopping (database will be closed after stop)
        expect(duron.spansEnabled).toBe(true)
        const result = await duron.getSpans({ jobId: job.id })

        await duron.stop()

        // Verify spans were recorded with metric events
        expect(result.spans.length).toBeGreaterThan(0)

        // Find job span and check for metric events
        const jobSpan = result.spans.find((s) => s.name.startsWith('job:'))
        expect(jobSpan).toBeDefined()
        expect(jobSpan!.events.length).toBeGreaterThanOrEqual(2) // At least 2 metrics recorded
      })
    })

    describe('spansEnabled property', () => {
      it('should be false when telemetry is not configured', async () => {
        duron = new Client({
          id: 'test-no-telemetry',
          database,
          actions: {},
          logger: 'silent',
        })

        expect(duron.spansEnabled).toBe(false)
      })

      it('should be true when telemetry.local is enabled', async () => {
        duron = new Client({
          id: 'test-local-telemetry',
          database,
          actions: {},
          logger: 'silent',
          telemetry: {
            local: true,
          },
        })

        expect(duron.spansEnabled).toBe(true)
      })
    })

    describe('getSpans API', () => {
      it('should return spans for a completed job', async () => {
        const action = defineAction()({
          name: 'spans-test',
          handler: async (ctx) => {
            await ctx.step('step-1', async () => ({ result: 'result-1' }))
            await ctx.step('step-2', async () => ({ result: 'result-2' }))
            return { result: 'done' }
          },
        })

        duron = new Client({
          id: 'test-get-spans',
          database,
          actions: { action },
          logger: 'silent',
          telemetry: {
            local: true,
          },
        })

        await duron.start()
        const job = await duron.runActionAndWait('action', {})
        await duron.stop()

        const result = await duron.getSpans({ jobId: job.id })
        expect(result.spans.length).toBe(3) // 1 job span + 2 step spans
        expect(result.total).toBe(3)

        // Verify span structure
        const jobSpan = result.spans.find((s) => s.name === 'job:spans-test')
        expect(jobSpan).toBeDefined()
        expect(jobSpan!.jobId).toBe(job.id)
        expect(jobSpan!.kind).toBe(SpanKind.INTERNAL)
        expect(jobSpan!.statusCode).toBe(SpanStatusCode.OK)

        // Verify step spans
        const step1Span = result.spans.find((s) => s.name === 'step:step-1')
        expect(step1Span).toBeDefined()
        expect(step1Span!.jobId).toBe(job.id)
        expect(step1Span!.stepId).toBeDefined()
      })

      it('should return empty spans when telemetry is disabled', async () => {
        duron = new Client({
          id: 'test-no-spans',
          database,
          actions: {},
          logger: 'silent',
        })

        const result = await duron.getSpans({ jobId: 'non-existent' })
        expect(result.spans).toEqual([])
        expect(result.total).toBe(0)
      })
    })

    describe('Custom SpanProcessor integration', () => {
      it('should allow custom span processors alongside local exporter', async () => {
        const customExporter = new InMemorySpanExporter()
        const customProcessor = new SimpleSpanProcessor(customExporter)

        const action = defineAction()({
          name: 'custom-processor-test',
          handler: async (ctx) => {
            await ctx.step('test-step', async () => ({ result: 'result' }))
            return { result: 'done' }
          },
        })

        duron = new Client({
          id: 'test-custom-processor',
          database,
          actions: { action },
          logger: 'silent',
          telemetry: {
            local: true,
            spanProcessors: [customProcessor],
          },
        })

        await duron.start()
        const job = await duron.runActionAndWait('action', {})
        await duron.stop()

        // Verify spans were sent to both exporters
        // Local exporter stores to database
        const localSpans = await duron.getSpans({ jobId: job.id })
        expect(localSpans.spans.length).toBeGreaterThan(0)

        // Custom exporter also received spans
        const customSpans = customExporter.getFinishedSpans()
        expect(customSpans.length).toBeGreaterThan(0)
      })
    })

    describe('Span parent-child relationships', () => {
      it('should create proper parent-child relationships for nested steps', async () => {
        const action = defineAction()({
          name: 'nested-steps-test',
          handler: async (ctx) => {
            await ctx.step('parent-step', async (parentCtx) => {
              await parentCtx.step('child-step-1', async () => ({ result: 'child-1' }))
              await parentCtx.step('child-step-2', async () => ({ result: 'child-2' }))
              return { result: 'parent-result' }
            })
            return { result: 'done' }
          },
        })

        duron = new Client({
          id: 'test-nested-spans',
          database,
          actions: { action },
          logger: 'silent',
          telemetry: {
            local: true,
          },
        })

        await duron.start()
        const job = await duron.runActionAndWait('action', {})
        await duron.stop()

        const result = await duron.getSpans({ jobId: job.id })
        expect(result.spans.length).toBe(4) // 1 job + 1 parent + 2 children

        const jobSpan = result.spans.find((s) => s.name === 'job:nested-steps-test')
        const parentSpan = result.spans.find((s) => s.name === 'step:parent-step')
        const child1Span = result.spans.find((s) => s.name === 'step:child-step-1')
        const child2Span = result.spans.find((s) => s.name === 'step:child-step-2')

        expect(jobSpan).toBeDefined()
        expect(parentSpan).toBeDefined()
        expect(child1Span).toBeDefined()
        expect(child2Span).toBeDefined()

        // Verify parent-child relationships via parent span IDs
        expect(parentSpan!.parentSpanId).toBe(jobSpan!.spanId)
        expect(child1Span!.parentSpanId).toBe(parentSpan!.spanId)
        expect(child2Span!.parentSpanId).toBe(parentSpan!.spanId)
      })
    })

    describe('Error handling in spans', () => {
      it('should record error status when job fails', async () => {
        const action = defineAction()({
          name: 'error-test',
          handler: async (): Promise<{ result: string }> => {
            throw new Error('Test error')
          },
        })

        duron = new Client({
          id: 'test-error-spans',
          database,
          actions: { action },
          logger: 'silent',
          telemetry: {
            local: true,
          },
        })

        await duron.start()

        let jobId: string | undefined
        try {
          jobId = await duron.runAction('action', {})
          await duron.waitForJob(jobId)
        } catch {
          // Ignore error
        }

        // We need to get the jobId from the failed job
        // Query the database directly to find the job
        const jobs = await duron.getJobs({ filters: { status: 'failed' }, pageSize: 1 })
        const failedJobId = jobs.jobs[0]?.id ?? jobId

        await duron.stop()

        const result = await duron.getSpans({ jobId: failedJobId! })
        const jobSpan = result.spans.find((s) => s.name === 'job:error-test')
        expect(jobSpan).toBeDefined()
        expect(jobSpan!.statusCode).toBe(SpanStatusCode.ERROR)
        expect(jobSpan!.statusMessage).toContain('Test error')
      })
    })

    describe('Custom spans with getTracer', () => {
      it('should capture spans created with ctx.telemetry.getTracer()', async () => {
        const action = defineAction()({
          name: 'custom-tracer-test',
          handler: async (ctx) => {
            await ctx.step('step-with-custom-span', async (stepCtx) => {
              // Get a tracer from the telemetry context
              const tracer = stepCtx.telemetry.getTracer('custom-tracer')

              // Create a custom span
              const customSpan = tracer.startSpan('my-custom-operation', {
                attributes: {
                  'custom.attribute': 'test-value',
                  'custom.number': 42,
                },
              })

              // Simulate some work
              await new Promise((resolve) => setTimeout(resolve, 10))

              // Add an event to the span
              customSpan.addEvent('work-completed', {
                'event.detail': 'finished processing',
              })

              customSpan.setStatus({ code: SpanStatusCode.OK })
              customSpan.end()

              return { result: 'done' }
            })

            return { result: 'success' }
          },
        })

        duron = new Client({
          id: 'test-custom-tracer',
          database,
          actions: { action },
          logger: 'silent',
          telemetry: {
            local: true,
          },
        })

        await duron.start()
        const job = await duron.runActionAndWait('action', {})
        await duron.stop()

        // Query by jobId - this should return all spans in the same trace,
        // including custom spans that share the same traceId
        const result = await duron.getSpans({ jobId: job.id })

        // Should have: 1 job span + 1 step span + 1 custom span
        expect(result.spans.length).toBeGreaterThanOrEqual(3)

        // Find the custom span by name
        const customSpan = result.spans.find((s) => s.name === 'my-custom-operation')
        expect(customSpan).toBeDefined()
        expect(customSpan!.attributes['custom.attribute']).toBe('test-value')
        expect(customSpan!.attributes['custom.number']).toBe(42)
        expect(customSpan!.statusCode).toBe(SpanStatusCode.OK)

        // Verify the custom span has events
        expect(customSpan!.events.length).toBeGreaterThanOrEqual(1)
        const workEvent = customSpan!.events.find((e) => e.name === 'work-completed')
        expect(workEvent).toBeDefined()
      })

      it('should link custom spans to parent step span when using context', async () => {
        // Import context and trace for this test
        const { context, trace } = await import('@opentelemetry/api')

        const action = defineAction()({
          name: 'linked-custom-span-test',
          handler: async (ctx) => {
            await ctx.step('parent-step', async (stepCtx) => {
              const tracer = stepCtx.telemetry.getTracer('linked-tracer')

              // Get the parent span and create a proper context
              const parentSpan = stepCtx.telemetry.getActiveSpan()
              const parentContext = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active()

              // Create a child span with proper parent context
              const childSpan = tracer.startSpan(
                'linked-child-span',
                { attributes: { 'child.test': true } },
                parentContext,
              )

              await new Promise((resolve) => setTimeout(resolve, 5))
              childSpan.end()

              return { result: 'done' }
            })

            return { result: 'success' }
          },
        })

        duron = new Client({
          id: 'test-linked-custom-span',
          database,
          actions: { action },
          logger: 'silent',
          telemetry: {
            local: true,
          },
        })

        await duron.start()
        const job = await duron.runActionAndWait('action', {})
        await duron.stop()

        // Query by jobId - this returns all spans in the same trace
        const result = await duron.getSpans({ jobId: job.id })

        // Find the step span and custom span
        const stepSpan = result.spans.find((s) => s.name === 'step:parent-step')
        const childSpan = result.spans.find((s) => s.name === 'linked-child-span')

        expect(stepSpan).toBeDefined()
        expect(childSpan).toBeDefined()

        // Verify the custom span is linked to the step span as its parent
        expect(childSpan!.parentSpanId).toBe(stepSpan!.spanId)

        // Verify they share the same trace ID
        expect(childSpan!.traceId).toBe(stepSpan!.traceId)
      })
    })
  })
}

// Run tests with PGLite (in-memory)
runSpansTests(pgliteFactory)

// Run tests with PostgreSQL (Docker)
runSpansTests(postgresFactory)
