import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_COMPLETED, JOB_STATUS_FAILED } from '../src/constants.js'
import { type Adapter, pgliteFactory } from './adapters.js'

// Simple action for basic telemetry testing
const simpleAction = defineAction()({
  name: 'simple-action',
  version: '1.0.0',
  input: z.object({
    value: z.number(),
  }),
  output: z.object({
    result: z.number(),
  }),
  handler: async (ctx) => {
    return { result: ctx.input.value * 2 }
  },
})

// Action with a single step
const stepAction = defineAction()({
  name: 'step-action',
  version: '1.0.0',
  input: z.object({
    value: z.number(),
  }),
  output: z.object({
    result: z.number(),
  }),
  handler: async (ctx) => {
    const stepResult = await ctx.step('multiply', async () => {
      return { multiplied: ctx.input.value * 2 }
    })
    return { result: stepResult.multiplied }
  },
})

// Action with nested steps
const nestedStepAction = defineAction()({
  name: 'nested-step-action',
  version: '1.0.0',
  input: z.object({
    value: z.number(),
  }),
  output: z.object({
    result: z.number(),
  }),
  handler: async (ctx) => {
    const result = await ctx.step('outer', async ({ step }) => {
      const innerResult = await step('inner', async () => {
        return { value: ctx.input.value * 2 }
      })
      return { doubled: innerResult.value }
    })
    return { result: result.doubled }
  },
})

// Action with telemetry recording
const telemetryAction = defineAction()({
  name: 'telemetry-action',
  version: '1.0.0',
  input: z.object({
    value: z.number(),
  }),
  output: z.object({
    result: z.number(),
  }),
  handler: async (ctx) => {
    // Record a metric at the job level
    ctx.telemetry.recordMetric('input.value', ctx.input.value)

    const result = await ctx.step('process', async ({ telemetry }) => {
      // Record metrics at the step level
      telemetry.recordMetric('processing.start', 1)
      const processed = ctx.input.value * 3
      telemetry.recordMetric('processing.result', processed)
      return { processed }
    })

    return { result: result.processed }
  },
})

// Action with custom spans via startSpan()
const customSpanAction = defineAction()({
  name: 'custom-span-action',
  version: '1.0.0',
  input: z.object({
    value: z.number(),
  }),
  output: z.object({
    result: z.number(),
  }),
  handler: async (ctx) => {
    const result = await ctx.step('with-custom-span', async ({ telemetry }) => {
      // Create a custom span that is properly linked to the trace
      const customSpan = telemetry.startSpan('custom-operation', {
        attributes: { 'custom.input': ctx.input.value },
      })

      // Simulate some work
      const processed = ctx.input.value * 4
      customSpan.setAttribute('custom.output', processed)
      customSpan.end()

      return { processed }
    })

    return { result: result.processed }
  },
})

// Action with named tracer (simulating AI SDK pattern)
const namedTracerAction = defineAction()({
  name: 'named-tracer-action',
  version: '1.0.0',
  input: z.object({
    value: z.number(),
  }),
  output: z.object({
    result: z.number(),
  }),
  handler: async (ctx) => {
    const result = await ctx.step('with-named-tracer', async ({ telemetry }) => {
      // Get a tracer with a custom name (like AI SDK does)
      const aiTracer = telemetry.getTracer('ai')
      const activeSpan = telemetry.getActiveSpan()

      // Create a span with the named tracer, using the active span as parent
      const parentContext = activeSpan
        ? require('@opentelemetry/api').trace.setSpan(require('@opentelemetry/api').context.active(), activeSpan)
        : require('@opentelemetry/api').context.active()

      const aiSpan = aiTracer.startSpan('ai.generate', { attributes: { 'ai.model': 'gpt-4' } }, parentContext)

      // Simulate AI work
      const processed = ctx.input.value * 5
      aiSpan.setAttribute('ai.tokens', 100)
      aiSpan.end()

      return { processed }
    })

    return { result: result.processed }
  },
})

// Action that fails
const failingAction = defineAction()({
  name: 'failing-action',
  version: '1.0.0',
  input: z.object({}),
  output: z.object({
    result: z.string(),
  }),
  handler: async () => {
    throw new Error('Intentional failure')
  },
})

describe('Telemetry Tests with pglite', () => {
  let client: Client<
    {
      simpleAction: typeof simpleAction
      stepAction: typeof stepAction
      nestedStepAction: typeof nestedStepAction
      telemetryAction: typeof telemetryAction
      customSpanAction: typeof customSpanAction
      namedTracerAction: typeof namedTracerAction
      failingAction: typeof failingAction
    },
    Record<string, unknown>
  >
  let database: Adapter
  let deleteDb: () => Promise<void>

  beforeEach(
    async () => {
      const adapterInstance = await pgliteFactory.create({})
      database = adapterInstance.adapter
      deleteDb = adapterInstance.deleteDb

      client = new Client({
        database,
        actions: {
          simpleAction,
          stepAction,
          nestedStepAction,
          telemetryAction,
          customSpanAction,
          namedTracerAction,
          failingAction,
        },
        telemetry: {
          local: {
            flushDelayMs: 100, // Fast flush for tests
          },
          serviceName: 'duron-test',
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

  describe('spansEnabled', () => {
    it('should report spansEnabled as true when telemetry.local is enabled', () => {
      expect(client.spansEnabled).toBe(true)
    })
  })

  describe('Job Spans', () => {
    it('should create a job span for a simple action', async () => {
      const jobId = await client.runAction('simpleAction', { value: 5 })
      await client.fetch()

      const job = await client.waitForJob(jobId)
      expect(job?.status).toBe(JOB_STATUS_COMPLETED)

      // Force flush spans to ensure they're exported
      await client.flushTelemetry()

      const { spans } = await client.getSpans({ jobId })

      expect(spans.length).toBeGreaterThanOrEqual(1)

      // Find the job span
      const jobSpan = spans.find((s) => s.name === 'job:simple-action')
      expect(jobSpan).toBeDefined()
      expect(jobSpan!.jobId).toBe(jobId)
      expect(jobSpan!.stepId).toBeNull()
      expect(jobSpan!.statusCode).toBe(1) // OK status
    })

    it('should create job and step spans', async () => {
      const jobId = await client.runAction('stepAction', { value: 7 })
      await client.fetch({})

      const job = await client.waitForJob(jobId)
      expect(job?.status).toBe(JOB_STATUS_COMPLETED)

      // Force flush spans to ensure they're exported
      await client.flushTelemetry()

      const { spans } = await client.getSpans({ jobId })

      // Should have job span and step span
      expect(spans.length).toBeGreaterThanOrEqual(2)

      const jobSpan = spans.find((s) => s.name === 'job:step-action')
      const stepSpan = spans.find((s) => s.name === 'step:multiply')

      expect(jobSpan).toBeDefined()
      expect(stepSpan).toBeDefined()

      // Step span should have parent
      expect(stepSpan!.parentSpanId).toBe(jobSpan!.spanId)
      expect(stepSpan!.traceId).toBe(jobSpan!.traceId)
    })

    it('should create nested step spans with proper hierarchy', async () => {
      const jobId = await client.runAction('nestedStepAction', { value: 3 })
      await client.fetch({})

      const job = await client.waitForJob(jobId)
      expect(job?.status).toBe(JOB_STATUS_COMPLETED)

      // Force flush spans to ensure they're exported
      await client.flushTelemetry()

      const { spans } = await client.getSpans({ jobId })

      // Should have job span, outer step span, and inner step span
      expect(spans.length).toBeGreaterThanOrEqual(3)

      const jobSpan = spans.find((s) => s.name === 'job:nested-step-action')
      const outerSpan = spans.find((s) => s.name === 'step:outer')
      const innerSpan = spans.find((s) => s.name === 'step:inner')

      expect(jobSpan).toBeDefined()
      expect(outerSpan).toBeDefined()
      expect(innerSpan).toBeDefined()

      // Verify hierarchy: job -> outer -> inner
      expect(outerSpan!.parentSpanId).toBe(jobSpan!.spanId)
      expect(innerSpan!.parentSpanId).toBe(outerSpan!.spanId)

      // All spans should share the same trace ID
      expect(outerSpan!.traceId).toBe(jobSpan!.traceId)
      expect(innerSpan!.traceId).toBe(jobSpan!.traceId)
    })
  })

  describe('Span Metrics', () => {
    it('should record metrics as span events', async () => {
      const jobId = await client.runAction('telemetryAction', { value: 10 })
      await client.fetch({})

      const job = await client.waitForJob(jobId)
      expect(job?.status).toBe(JOB_STATUS_COMPLETED)

      // Force flush spans to ensure they're exported
      await client.flushTelemetry()

      const { spans } = await client.getSpans({ jobId })

      const jobSpan = spans.find((s) => s.name === 'job:telemetry-action')
      const stepSpan = spans.find((s) => s.name === 'step:process')

      expect(jobSpan).toBeDefined()
      expect(stepSpan).toBeDefined()

      // Check job-level metric
      const jobMetric = jobSpan!.events.find((e) => e.name === 'metric:input.value')
      expect(jobMetric).toBeDefined()
      expect(jobMetric!.attributes?.['metric.value']).toBe(10)

      // Check step-level metrics
      const startMetric = stepSpan!.events.find((e) => e.name === 'metric:processing.start')
      const resultMetric = stepSpan!.events.find((e) => e.name === 'metric:processing.result')

      expect(startMetric).toBeDefined()
      expect(startMetric!.attributes?.['metric.value']).toBe(1)

      expect(resultMetric).toBeDefined()
      expect(resultMetric!.attributes?.['metric.value']).toBe(30) // 10 * 3
    })
  })

  describe('Custom Spans via startSpan', () => {
    it('should store custom spans created via startSpan()', async () => {
      const jobId = await client.runAction('customSpanAction', { value: 5 })
      await client.fetch({})

      const job = await client.waitForJob(jobId)
      expect(job?.status).toBe(JOB_STATUS_COMPLETED)

      // Force flush spans to ensure they're exported
      await client.flushTelemetry()

      const { spans } = await client.getSpans({ jobId })

      // Should have job span, step span, and custom span
      expect(spans.length).toBeGreaterThanOrEqual(3)

      const jobSpan = spans.find((s) => s.name === 'job:custom-span-action')
      const stepSpan = spans.find((s) => s.name === 'step:with-custom-span')
      const customSpan = spans.find((s) => s.name === 'custom-operation')

      expect(jobSpan).toBeDefined()
      expect(stepSpan).toBeDefined()
      expect(customSpan).toBeDefined()

      // Custom span should have the custom attributes
      expect(customSpan!.attributes['custom.input']).toBe(5)
      expect(customSpan!.attributes['custom.output']).toBe(20) // 5 * 4

      // All spans should share the same trace ID
      expect(customSpan!.traceId).toBe(jobSpan!.traceId)
    })

    it('should store spans from named tracers (like AI SDK)', async () => {
      const jobId = await client.runAction('namedTracerAction', { value: 3 })
      await client.fetch({})

      const job = await client.waitForJob(jobId)
      expect(job?.status).toBe(JOB_STATUS_COMPLETED)

      // Force flush spans to ensure they're exported
      await client.flushTelemetry()

      const { spans } = await client.getSpans({ jobId })

      // Should have job span, step span, and AI span
      expect(spans.length).toBeGreaterThanOrEqual(3)

      const jobSpan = spans.find((s) => s.name === 'job:named-tracer-action')
      const stepSpan = spans.find((s) => s.name === 'step:with-named-tracer')
      const aiSpan = spans.find((s) => s.name === 'ai.generate')

      expect(jobSpan).toBeDefined()
      expect(stepSpan).toBeDefined()
      expect(aiSpan).toBeDefined()

      // AI span should have the AI-specific attributes
      expect(aiSpan!.attributes['ai.model']).toBe('gpt-4')
      expect(aiSpan!.attributes['ai.tokens']).toBe(100)

      // All spans should share the same trace ID
      expect(aiSpan!.traceId).toBe(jobSpan!.traceId)
    })
  })

  describe('Failed Job Spans', () => {
    it('should create spans with error status for failed jobs', async () => {
      const jobId = await client.runAction('failingAction', {})
      await client.fetch({})

      const job = await client.waitForJob(jobId)
      expect(job?.status).toBe(JOB_STATUS_FAILED)

      // Force flush spans to ensure they're exported
      await client.flushTelemetry()

      const { spans } = await client.getSpans({ jobId })

      expect(spans.length).toBeGreaterThanOrEqual(1)

      const jobSpan = spans.find((s) => s.name === 'job:failing-action')
      expect(jobSpan).toBeDefined()
      expect(jobSpan!.statusCode).toBe(2) // ERROR status
      expect(jobSpan!.statusMessage).toContain('Intentional failure')
    })
  })

  describe('Span Attributes', () => {
    it('should include duron-specific attributes in spans', async () => {
      const jobId = await client.runAction('stepAction', { value: 5 })
      await client.fetch({})

      await client.waitForJob(jobId)

      // Force flush spans to ensure they're exported
      await client.flushTelemetry()

      const { spans } = await client.getSpans({ jobId })

      const jobSpan = spans.find((s) => s.name === 'job:step-action')
      const stepSpan = spans.find((s) => s.name === 'step:multiply')

      expect(jobSpan).toBeDefined()
      expect(stepSpan).toBeDefined()

      // Job span should have action name attribute
      expect(jobSpan!.attributes['duron.action.name']).toBe('step-action')

      // Step span should have step name attribute
      expect(stepSpan!.attributes['duron.step.name']).toBe('multiply')
    })
  })
})

describe('Telemetry Tests - No-Op Mode', () => {
  let client: Client<
    {
      simpleAction: typeof simpleAction
    },
    Record<string, unknown>
  >
  let database: Adapter
  let deleteDb: () => Promise<void>

  beforeEach(
    async () => {
      const adapterInstance = await pgliteFactory.create({})
      database = adapterInstance.adapter
      deleteDb = adapterInstance.deleteDb

      // Create client WITHOUT telemetry options
      client = new Client({
        database,
        actions: {
          simpleAction,
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

  it('should report spansEnabled as false when telemetry is not configured', () => {
    expect(client.spansEnabled).toBe(false)
  })

  it('should still have a tracer available (no-op tracer)', () => {
    // The tracer should always be available, even if it's a no-op
    expect(client.tracer).toBeDefined()
  })

  it('should execute jobs successfully without telemetry', async () => {
    const jobId = await client.runAction('simpleAction', { value: 5 })
    await client.fetch({})

    const job = await client.waitForJob(jobId)
    expect(job?.status).toBe(JOB_STATUS_COMPLETED)
    expect(job?.output).toEqual({ result: 10 })
  })

  it('should throw error when trying to get spans without telemetry enabled', async () => {
    const jobId = await client.runAction('simpleAction', { value: 5 })
    await client.fetch({})
    await client.waitForJob(jobId)

    await expect(client.getSpans({ jobId })).rejects.toThrow('Spans are only available when telemetry.local is enabled')
  })
})
