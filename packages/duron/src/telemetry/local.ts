import type { Adapter, InsertMetricOptions } from '../adapters/adapter.js'
import {
  type AddSpanAttributeOptions,
  type AddSpanEventOptions,
  type EndSpanOptions,
  type RecordMetricOptions,
  type Span,
  type StartDatabaseSpanOptions,
  type StartJobSpanOptions,
  type StartSpanOptions,
  type StartStepSpanOptions,
  TelemetryAdapter,
  type Tracer,
  type TracerSpan,
} from './adapter.js'

// ============================================================================
// Types
// ============================================================================

export interface LocalTelemetryAdapterOptions {
  /**
   * Delay in milliseconds before flushing queued metrics to the database.
   * Metrics are batched and inserted after this delay of inactivity.
   * @default 1000
   */
  flushDelayMs?: number
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_FLUSH_DELAY_MS = 1000

// ============================================================================
// Local Telemetry Adapter
// ============================================================================

/**
 * Local telemetry adapter that stores metrics directly in the Duron database.
 * Perfect for development and self-hosted deployments.
 *
 * This adapter automatically uses the database adapter configured in the Duron client.
 * Metrics are batched and inserted after a configurable delay of inactivity to reduce database load.
 *
 * @example
 * ```typescript
 * const client = duron({
 *   database: postgresAdapter({ connection: 'postgres://...' }),
 *   telemetry: localTelemetryAdapter({ flushDelayMs: 500 }), // Custom 500ms delay
 *   actions: { ... }
 * })
 * ```
 */
export class LocalTelemetryAdapter extends TelemetryAdapter {
  #spanStartTimes = new Map<string, number>()
  #metricsQueue: InsertMetricOptions[] = []
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #flushPromise: Promise<void> | null = null
  #flushDelayMs: number

  constructor(options?: LocalTelemetryAdapterOptions) {
    super()
    this.#flushDelayMs = options?.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS
  }

  /**
   * Get the database adapter from the Duron client.
   * @throws Error if the client is not set
   */
  get #database(): Adapter {
    const client = this.client
    if (!client) {
      throw new Error(
        'LocalTelemetryAdapter requires the Duron client to be set. This is done automatically by the Duron client.',
      )
    }
    return client.database
  }

  // ============================================================================
  // Queue Management
  // ============================================================================

  /**
   * Queue a metric for batch insertion.
   * The metric will be inserted after 1 second of inactivity.
   */
  #queueMetric(options: InsertMetricOptions): void {
    this.#metricsQueue.push(options)
    this.#scheduleFlush()
  }

  /**
   * Schedule a flush of the metrics queue.
   * Resets the timer on each call (debounce behavior).
   */
  #scheduleFlush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer)
    }

    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null
      this.#flushPromise = this.#flushQueue().finally(() => {
        this.#flushPromise = null
      })
    }, this.#flushDelayMs)
  }

  /**
   * Flush all queued metrics to the database.
   */
  async #flushQueue(): Promise<void> {
    if (this.#metricsQueue.length === 0) {
      return
    }

    // Take all metrics from the queue
    const metrics = this.#metricsQueue.splice(0, this.#metricsQueue.length)

    // Batch insert all metrics in a single database operation
    await this.#database.insertMetrics(metrics)
  }

  /**
   * Force flush the queue immediately.
   * Used during shutdown to ensure all metrics are persisted.
   */
  async #forceFlush(): Promise<void> {
    // Clear any pending timer
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = null
    }

    // Wait for any in-progress flush
    if (this.#flushPromise) {
      await this.#flushPromise
    }

    // Flush remaining metrics
    await this.#flushQueue()
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  protected async _start(): Promise<void> {
    // Database adapter should already be started by the client
  }

  protected async _stop(): Promise<void> {
    // Flush any remaining metrics before stopping
    await this.#forceFlush()
    this.#spanStartTimes.clear()
  }

  // ============================================================================
  // Span Methods
  // ============================================================================

  protected async _startJobSpan(options: StartJobSpanOptions): Promise<Span> {
    const spanId = `job:${options.jobId}`
    this.#spanStartTimes.set(spanId, Date.now())

    // Record span start as a metric
    this.#queueMetric({
      jobId: options.jobId,
      name: 'duron.job.span.start',
      value: Date.now(),
      type: 'span_event',
      attributes: {
        actionName: options.actionName,
        groupKey: options.groupKey,
        spanId,
      },
    })

    return {
      id: spanId,
      jobId: options.jobId,
      stepId: null,
      parentSpanId: null,
    }
  }

  protected async _endJobSpan(span: Span, options: EndSpanOptions): Promise<void> {
    const startTime = this.#spanStartTimes.get(span.id)
    const duration = startTime ? Date.now() - startTime : 0
    this.#spanStartTimes.delete(span.id)

    // Record span end with duration
    this.#queueMetric({
      jobId: span.jobId,
      name: 'duron.job.span.end',
      value: duration,
      type: 'span_event',
      attributes: {
        spanId: span.id,
        status: options.status,
        error: options.error?.message ?? null,
        durationMs: duration,
      },
    })
  }

  protected async _startStepSpan(options: StartStepSpanOptions): Promise<Span> {
    const spanId = `step:${options.stepId}`
    this.#spanStartTimes.set(spanId, Date.now())

    // Record span start as a metric
    this.#queueMetric({
      jobId: options.jobId,
      stepId: options.stepId,
      name: 'duron.step.span.start',
      value: Date.now(),
      type: 'span_event',
      attributes: {
        stepName: options.stepName,
        parentStepId: options.parentStepId,
        parentSpanId: options.parentSpan?.id ?? null,
        spanId,
      },
    })

    return {
      id: spanId,
      jobId: options.jobId,
      stepId: options.stepId,
      parentSpanId: options.parentSpan?.id ?? null,
    }
  }

  protected async _endStepSpan(span: Span, options: EndSpanOptions): Promise<void> {
    const startTime = this.#spanStartTimes.get(span.id)
    const duration = startTime ? Date.now() - startTime : 0
    this.#spanStartTimes.delete(span.id)

    // Record span end with duration
    this.#queueMetric({
      jobId: span.jobId,
      stepId: span.stepId ?? undefined,
      name: 'duron.step.span.end',
      value: duration,
      type: 'span_event',
      attributes: {
        spanId: span.id,
        status: options.status,
        error: options.error?.message ?? null,
        durationMs: duration,
      },
    })
  }

  protected async _startDatabaseSpan(_options: StartDatabaseSpanOptions): Promise<Span | null> {
    // Local adapter doesn't trace database operations to avoid infinite loops
    return null
  }

  protected async _endDatabaseSpan(_span: Span, _options: EndSpanOptions): Promise<void> {
    // No-op for local adapter
  }

  // ============================================================================
  // Metrics Methods
  // ============================================================================

  protected async _recordMetric(options: RecordMetricOptions): Promise<void> {
    this.#queueMetric({
      jobId: options.jobId,
      stepId: options.stepId,
      name: options.name,
      value: options.value,
      type: 'metric',
      attributes: options.attributes,
    })
  }

  protected async _addSpanEvent(options: AddSpanEventOptions): Promise<void> {
    this.#queueMetric({
      jobId: options.span.jobId,
      stepId: options.span.stepId ?? undefined,
      name: options.name,
      value: Date.now(),
      type: 'span_event',
      attributes: {
        spanId: options.span.id,
        ...options.attributes,
      },
    })
  }

  protected async _addSpanAttribute(options: AddSpanAttributeOptions): Promise<void> {
    this.#queueMetric({
      jobId: options.span.jobId,
      stepId: options.span.stepId ?? undefined,
      name: `attribute:${options.key}`,
      value: typeof options.value === 'number' ? options.value : 0,
      type: 'span_attribute',
      attributes: {
        spanId: options.span.id,
        key: options.key,
        value: String(options.value),
      },
    })
  }

  // ============================================================================
  // Tracer Methods
  // ============================================================================

  protected _getTracer(name: string): Tracer {
    const adapter = this

    return {
      name,

      startSpan(spanName: string, options?: StartSpanOptions): TracerSpan {
        const spanId = `tracer:${name}:${globalThis.crypto.randomUUID()}`
        const startTime = Date.now()
        let ended = false
        const attributes: Record<string, string | number | boolean> = {
          ...options?.attributes,
        }

        // Note: Local adapter tracer spans don't have a jobId context,
        // so they can't be stored in the database. They're essentially no-ops
        // but provide a consistent API for code that needs a tracer.
        // For actual metrics storage, use ctx.observe within action/step handlers.

        const tracerSpan: TracerSpan = {
          setAttribute(key: string, value: string | number | boolean): void {
            if (!ended) {
              attributes[key] = value
            }
          },

          setAttributes(attrs: Record<string, string | number | boolean>): void {
            if (!ended) {
              Object.assign(attributes, attrs)
            }
          },

          addEvent(eventName: string, eventAttrs?: Record<string, string | number | boolean>): void {
            if (!ended) {
              adapter.logger?.debug({ spanId, event: eventName, attributes: eventAttrs }, 'Tracer span event')
            }
          },

          recordException(error: Error): void {
            if (!ended) {
              attributes['error.message'] = error.message
              attributes['error.name'] = error.name
              adapter.logger?.debug({ spanId, error: error.message }, 'Tracer span exception')
            }
          },

          setStatusOk(): void {
            if (!ended) {
              // biome-ignore lint/complexity/useLiteralKeys: Index signature requires bracket notation
              attributes['status'] = 'ok'
            }
          },

          setStatusError(message?: string): void {
            if (!ended) {
              // biome-ignore lint/complexity/useLiteralKeys: Index signature requires bracket notation
              attributes['status'] = 'error'
              if (message) {
                attributes['status.message'] = message
              }
            }
          },

          end(): void {
            if (!ended) {
              ended = true
              const duration = Date.now() - startTime
              adapter.logger?.debug(
                { spanId, spanName, tracerName: name, durationMs: duration, attributes },
                'Tracer span ended',
              )
            }
          },

          isRecording(): boolean {
            return !ended
          },
        }

        adapter.logger?.debug({ spanId, spanName, tracerName: name }, 'Tracer span started')

        return tracerSpan
      },
    }
  }
}

/**
 * Create a local telemetry adapter that stores metrics in the Duron database.
 * Perfect for development and self-hosted deployments.
 *
 * The database adapter is automatically obtained from the Duron client.
 * Metrics are batched and inserted after a configurable delay of inactivity to reduce database load.
 *
 * @param options - Configuration options
 * @param options.flushDelayMs - Delay in milliseconds before flushing queued metrics (default: 1000)
 * @returns LocalTelemetryAdapter instance
 *
 * @example
 * ```typescript
 * const client = duron({
 *   database: postgresAdapter({ connection: 'postgres://...' }),
 *   telemetry: localTelemetryAdapter(), // Uses default 1 second delay
 *   actions: { ... }
 * })
 *
 * // Or with custom flush delay
 * const client = duron({
 *   database: postgresAdapter({ connection: 'postgres://...' }),
 *   telemetry: localTelemetryAdapter({ flushDelayMs: 500 }), // 500ms delay
 *   actions: { ... }
 * })
 * ```
 */
export const localTelemetryAdapter = (options?: LocalTelemetryAdapterOptions) => new LocalTelemetryAdapter(options)
