import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { type SpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { z } from 'zod'

import { defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_COMPLETED } from '../src/constants.js'

import { type Adapter, pgliteFactory } from './adapters.js'

/**
 * In-memory span exporter for testing.
 * Collects all exported spans in memory for assertion.
 */
class InMemorySpanExporter implements SpanExporter {
  private spans: ReadableSpan[] = []

  export(spans: ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
    this.spans.push(...spans)
    resultCallback({ code: 0 }) // SUCCESS
  }

  shutdown(): Promise<void> {
    this.spans = []
    return Promise.resolve()
  }

  getSpans(): ReadableSpan[] {
    return [...this.spans]
  }

  reset(): void {
    this.spans = []
  }
}

// Simple action for testing
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

// Action with a step
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

// Action with custom span
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
      const customSpan = telemetry.startSpan('custom-operation', {
        attributes: { 'custom.input': ctx.input.value },
      })
      const processed = ctx.input.value * 4
      customSpan.setAttribute('custom.output', processed)
      customSpan.end()
      return { processed }
    })
    return { result: result.processed }
  },
})

describe('OpenTelemetry Integration with External Exporter', () => {
  let exporter: InMemorySpanExporter
  let client: Client<
    {
      simpleAction: typeof simpleAction
      stepAction: typeof stepAction
      customSpanAction: typeof customSpanAction
    },
    Record<string, unknown>
  >
  let database: Adapter
  let deleteDb: () => Promise<void>

  beforeEach(
    async () => {
      exporter = new InMemorySpanExporter()

      const adapterInstance = await pgliteFactory.create({})
      database = adapterInstance.adapter
      deleteDb = adapterInstance.deleteDb

      client = new Client({
        database,
        actions: {
          simpleAction,
          stepAction,
          customSpanAction,
        },
        telemetry: {
          traceExporter: exporter,
          serviceName: 'duron-test',
          batchDelayMs: 100, // Fast flush for tests
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

  it('should export spans to external exporter', async () => {
    const jobId = await client.runAction('simpleAction', { value: 5 })
    await client.fetch()

    const job = await client.waitForJob(jobId)
    expect(job?.status).toBe(JOB_STATUS_COMPLETED)

    // Wait a bit for async export
    // Wait for spans to be exported (BatchSpanProcessor has a default 5s delay)
    await new Promise((resolve) => setTimeout(resolve, 500))

    const spans = exporter.getSpans()
    expect(spans.length).toBeGreaterThanOrEqual(1)

    // Find the job span
    const jobSpan = spans.find((s) => s.name === 'job:simple-action')
    expect(jobSpan).toBeDefined()
    expect(jobSpan!.attributes['duron.job.id']).toBe(jobId)
  })

  it('should export step spans with proper hierarchy', async () => {
    const jobId = await client.runAction('stepAction', { value: 7 })
    await client.fetch()

    const job = await client.waitForJob(jobId)
    expect(job?.status).toBe(JOB_STATUS_COMPLETED)

    await new Promise((resolve) => setTimeout(resolve, 500))

    const spans = exporter.getSpans()

    const jobSpan = spans.find((s) => s.name === 'job:step-action')
    const stepSpan = spans.find((s) => s.name === 'step:multiply')

    expect(jobSpan).toBeDefined()
    expect(stepSpan).toBeDefined()

    // Step span should be a child of job span (same trace ID)
    expect(stepSpan!.spanContext().traceId).toBe(jobSpan!.spanContext().traceId)
    // The step span should have a different span ID than the job span
    expect(stepSpan!.spanContext().spanId).not.toBe(jobSpan!.spanContext().spanId)
  })

  it('should export custom spans created via telemetry.startSpan()', async () => {
    const jobId = await client.runAction('customSpanAction', { value: 5 })
    await client.fetch()

    const job = await client.waitForJob(jobId)
    expect(job?.status).toBe(JOB_STATUS_COMPLETED)

    await new Promise((resolve) => setTimeout(resolve, 500))

    const spans = exporter.getSpans()

    const customSpan = spans.find((s) => s.name === 'custom-operation')
    expect(customSpan).toBeDefined()
    expect(customSpan!.attributes['custom.input']).toBe(5)
    expect(customSpan!.attributes['custom.output']).toBe(20)
  })

  it('should still execute jobs successfully with external exporter', async () => {
    const jobId = await client.runAction('simpleAction', { value: 10 })
    await client.fetch()

    const job = await client.waitForJob(jobId)
    expect(job?.status).toBe(JOB_STATUS_COMPLETED)
    expect(job?.output).toEqual({ result: 20 })
  })
})

describe('OpenTelemetry - Multiple Exporters', () => {
  let exporter1: InMemorySpanExporter
  let exporter2: InMemorySpanExporter
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
      exporter1 = new InMemorySpanExporter()
      exporter2 = new InMemorySpanExporter()

      const adapterInstance = await pgliteFactory.create({})
      database = adapterInstance.adapter
      deleteDb = adapterInstance.deleteDb

      client = new Client({
        database,
        actions: {
          simpleAction,
        },
        telemetry: {
          traceExporter: [exporter1, exporter2],
          serviceName: 'duron-test-multi',
          batchDelayMs: 100, // Fast flush for tests
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

  it('should export spans to all exporters', async () => {
    const jobId = await client.runAction('simpleAction', { value: 5 })
    await client.fetch()

    const job = await client.waitForJob(jobId)
    expect(job?.status).toBe(JOB_STATUS_COMPLETED)

    await new Promise((resolve) => setTimeout(resolve, 500))

    // Both exporters should have received the spans
    expect(exporter1.getSpans().length).toBeGreaterThanOrEqual(1)
    expect(exporter2.getSpans().length).toBeGreaterThanOrEqual(1)

    // Both should have the same job span
    const span1 = exporter1.getSpans().find((s) => s.name === 'job:simple-action')
    const span2 = exporter2.getSpans().find((s) => s.name === 'job:simple-action')
    expect(span1).toBeDefined()
    expect(span2).toBeDefined()
  })
})

describe('OpenTelemetry - No Config', () => {
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

      // No telemetry config
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

  it('should still have a tracer available (no-op)', () => {
    expect(client.tracer).toBeDefined()
  })

  it('should execute jobs successfully without telemetry', async () => {
    const jobId = await client.runAction('simpleAction', { value: 5 })
    await client.fetch()

    const job = await client.waitForJob(jobId)
    expect(job?.status).toBe(JOB_STATUS_COMPLETED)
    expect(job?.output).toEqual({ result: 10 })
  })
})
