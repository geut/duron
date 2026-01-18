import type { Span as OTelSpan, Tracer, TracerProvider } from '@opentelemetry/api'

import {
  type AddSpanAttributeOptions,
  type AddSpanEventOptions,
  type EndSpanOptions,
  type RecordMetricOptions,
  type Span,
  type StartDatabaseSpanOptions,
  type StartJobSpanOptions,
  type StartStepSpanOptions,
  TelemetryAdapter,
} from './adapter.js'

// ============================================================================
// Types
// ============================================================================

export interface OpenTelemetryAdapterOptions {
  /**
   * Service name for telemetry.
   * Used as the tracer name.
   */
  serviceName?: string

  /**
   * Optional TracerProvider to use.
   * If not provided, uses the global tracer provider.
   */
  tracerProvider?: TracerProvider

  /**
   * Whether to trace database queries.
   * @default false
   */
  traceDatabaseQueries?: boolean
}

interface ExtendedSpan extends Span {
  otelSpan: OTelSpan
}

// ============================================================================
// OpenTelemetry Adapter
// ============================================================================

/**
 * OpenTelemetry telemetry adapter.
 * Exports traces to external systems like Jaeger, OTLP, etc.
 */
export class OpenTelemetryAdapter extends TelemetryAdapter {
  #serviceName: string
  #tracerProvider: TracerProvider | null
  #traceDatabaseQueries: boolean
  #tracer: Tracer | null = null
  #spanMap = new Map<string, OTelSpan>()

  constructor(options: OpenTelemetryAdapterOptions = {}) {
    super()
    this.#serviceName = options.serviceName ?? 'duron'
    this.#tracerProvider = options.tracerProvider ?? null
    this.#traceDatabaseQueries = options.traceDatabaseQueries ?? false
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  protected async _start(): Promise<void> {
    // Dynamically import OpenTelemetry API to make it optional
    const api = await import('@opentelemetry/api')

    // Get tracer from provider or global
    if (this.#tracerProvider) {
      this.#tracer = this.#tracerProvider.getTracer(this.#serviceName)
    } else {
      this.#tracer = api.trace.getTracer(this.#serviceName)
    }
  }

  protected async _stop(): Promise<void> {
    this.#spanMap.clear()
    this.#tracer = null
  }

  // ============================================================================
  // Span Methods
  // ============================================================================

  protected async _startJobSpan(options: StartJobSpanOptions): Promise<Span> {
    if (!this.#tracer) {
      throw new Error('OpenTelemetry tracer not initialized')
    }

    const api = await import('@opentelemetry/api')

    const otelSpan = this.#tracer.startSpan(`job:${options.actionName}`, {
      kind: api.SpanKind.INTERNAL,
      attributes: {
        'duron.job.id': options.jobId,
        'duron.job.action_name': options.actionName,
        'duron.job.group_key': options.groupKey,
      },
    })

    const spanId = `job:${options.jobId}`
    this.#spanMap.set(spanId, otelSpan)

    const span: ExtendedSpan = {
      id: spanId,
      jobId: options.jobId,
      stepId: null,
      parentSpanId: null,
      otelSpan,
    }

    return span
  }

  protected async _endJobSpan(span: Span, options: EndSpanOptions): Promise<void> {
    const api = await import('@opentelemetry/api')
    const extSpan = span as ExtendedSpan
    const otelSpan = extSpan.otelSpan

    if (options.status === 'error') {
      otelSpan.setStatus({
        code: api.SpanStatusCode.ERROR,
        message: options.error?.message ?? 'Unknown error',
      })
      if (options.error) {
        otelSpan.recordException(options.error)
      }
    } else if (options.status === 'cancelled') {
      otelSpan.setStatus({
        code: api.SpanStatusCode.OK,
        message: 'Cancelled',
      })
      otelSpan.setAttribute('duron.job.cancelled', true)
    } else {
      otelSpan.setStatus({ code: api.SpanStatusCode.OK })
    }

    otelSpan.end()
    this.#spanMap.delete(span.id)
  }

  protected async _startStepSpan(options: StartStepSpanOptions): Promise<Span> {
    if (!this.#tracer) {
      throw new Error('OpenTelemetry tracer not initialized')
    }

    const api = await import('@opentelemetry/api')

    // Get parent span context
    let parentContext = api.context.active()
    if (options.parentSpan) {
      const parentExtSpan = options.parentSpan as ExtendedSpan
      if (parentExtSpan.otelSpan) {
        parentContext = api.trace.setSpan(api.context.active(), parentExtSpan.otelSpan)
      }
    }

    const otelSpan = this.#tracer.startSpan(
      `step:${options.stepName}`,
      {
        kind: api.SpanKind.INTERNAL,
        attributes: {
          'duron.job.id': options.jobId,
          'duron.step.id': options.stepId,
          'duron.step.name': options.stepName,
          'duron.step.parent_step_id': options.parentStepId ?? undefined,
        },
      },
      parentContext,
    )

    const spanId = `step:${options.stepId}`
    this.#spanMap.set(spanId, otelSpan)

    const span: ExtendedSpan = {
      id: spanId,
      jobId: options.jobId,
      stepId: options.stepId,
      parentSpanId: options.parentSpan?.id ?? null,
      otelSpan,
    }

    return span
  }

  protected async _endStepSpan(span: Span, options: EndSpanOptions): Promise<void> {
    const api = await import('@opentelemetry/api')
    const extSpan = span as ExtendedSpan
    const otelSpan = extSpan.otelSpan

    if (options.status === 'error') {
      otelSpan.setStatus({
        code: api.SpanStatusCode.ERROR,
        message: options.error?.message ?? 'Unknown error',
      })
      if (options.error) {
        otelSpan.recordException(options.error)
      }
    } else if (options.status === 'cancelled') {
      otelSpan.setStatus({
        code: api.SpanStatusCode.OK,
        message: 'Cancelled',
      })
      otelSpan.setAttribute('duron.step.cancelled', true)
    } else {
      otelSpan.setStatus({ code: api.SpanStatusCode.OK })
    }

    otelSpan.end()
    this.#spanMap.delete(span.id)
  }

  protected async _startDatabaseSpan(options: StartDatabaseSpanOptions): Promise<Span | null> {
    if (!this.#traceDatabaseQueries || !this.#tracer) {
      return null
    }

    const api = await import('@opentelemetry/api')

    const otelSpan = this.#tracer.startSpan(`db:${options.operation}`, {
      kind: api.SpanKind.CLIENT,
      attributes: {
        'db.system': 'postgresql',
        'db.operation': options.operation,
        'db.statement': options.query,
      },
    })

    const spanId = `db:${globalThis.crypto.randomUUID()}`
    this.#spanMap.set(spanId, otelSpan)

    const span: ExtendedSpan = {
      id: spanId,
      jobId: '',
      stepId: null,
      parentSpanId: null,
      otelSpan,
    }

    return span
  }

  protected async _endDatabaseSpan(span: Span, options: EndSpanOptions): Promise<void> {
    const api = await import('@opentelemetry/api')
    const extSpan = span as ExtendedSpan
    const otelSpan = extSpan.otelSpan

    if (options.status === 'error') {
      otelSpan.setStatus({
        code: api.SpanStatusCode.ERROR,
        message: options.error?.message ?? 'Unknown error',
      })
      if (options.error) {
        otelSpan.recordException(options.error)
      }
    } else {
      otelSpan.setStatus({ code: api.SpanStatusCode.OK })
    }

    otelSpan.end()
    this.#spanMap.delete(span.id)
  }

  // ============================================================================
  // Metrics Methods
  // ============================================================================

  protected async _recordMetric(options: RecordMetricOptions): Promise<void> {
    // OpenTelemetry metrics would require MeterProvider
    // For now, we record as span events on the current active span
    const api = await import('@opentelemetry/api')
    const activeSpan = api.trace.getActiveSpan()

    if (activeSpan) {
      activeSpan.addEvent('metric', {
        'metric.name': options.name,
        'metric.value': options.value,
        ...options.attributes,
      })
    }
  }

  protected async _addSpanEvent(options: AddSpanEventOptions): Promise<void> {
    const extSpan = options.span as ExtendedSpan
    if (extSpan.otelSpan) {
      extSpan.otelSpan.addEvent(options.name, options.attributes)
    }
  }

  protected async _addSpanAttribute(options: AddSpanAttributeOptions): Promise<void> {
    const extSpan = options.span as ExtendedSpan
    if (extSpan.otelSpan) {
      extSpan.otelSpan.setAttribute(options.key, options.value)
    }
  }
}

/**
 * Create an OpenTelemetry telemetry adapter.
 * Exports traces to external systems like Jaeger, OTLP, etc.
 *
 * @param options - Configuration options
 * @returns OpenTelemetryAdapter instance
 */
export const openTelemetryAdapter = (options?: OpenTelemetryAdapterOptions) => new OpenTelemetryAdapter(options)
