import type {
  SpanKind as OTelSpanKind,
  SpanStatusCode as OTelSpanStatusCode,
} from '@opentelemetry/api'
import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

import type { Adapter, InsertSpanOptions } from '../adapters/adapter.js'

/**
 * Configuration options for the LocalSpanExporter.
 */
export interface LocalSpanExporterOptions {
  /**
   * The database adapter to use for storing spans.
   * This is the same adapter used by the Duron Client.
   */
  adapter: Adapter
}

/**
 * A custom OpenTelemetry SpanExporter that stores spans locally in the database.
 *
 * This exporter converts OpenTelemetry ReadableSpan objects into database records
 * and inserts them via the Duron Adapter interface.
 *
 * It extracts `duron.job.id` and `duron.step.id` from span attributes to link
 * spans to Duron jobs and steps.
 *
 * @example
 * ```typescript
 * import { LocalSpanExporter } from 'duron/telemetry'
 * import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
 *
 * const exporter = new LocalSpanExporter({ adapter })
 * const processor = new BatchSpanProcessor(exporter)
 * ```
 */
export class LocalSpanExporter implements SpanExporter {
  #adapter: Adapter
  #shutdown = false

  constructor(options: LocalSpanExporterOptions) {
    this.#adapter = options.adapter
  }

  /**
   * Export spans to the local database.
   *
   * Converts ReadableSpan objects to database records and inserts them.
   * Follows OpenTelemetry exporter rules:
   * - Does not throw exceptions
   * - Does not modify received spans
   * - Does not implement queuing/batching (handled by SpanProcessor)
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.#shutdown) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Exporter has been shutdown'),
      })
      return
    }

    this.#exportSpans(spans)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS })
      })
      .catch((error) => {
        resultCallback({ code: ExportResultCode.FAILED, error })
      })
  }

  /**
   * Shutdown the exporter.
   * After shutdown, no more spans will be exported.
   */
  async shutdown(): Promise<void> {
    this.#shutdown = true
  }

  /**
   * Force flush any pending exports.
   * Since we export synchronously to the database, this is a no-op.
   */
  async forceFlush(): Promise<void> {
    // No-op: we don't buffer spans, they're exported immediately
  }

  /**
   * Internal method to export spans to the database.
   */
  async #exportSpans(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) {
      return
    }

    const records = spans.map((span) => this.#readableSpanToRecord(span))
    await this.#adapter.insertSpans(records)
  }

  /**
   * Convert a ReadableSpan to an InsertSpanOptions record.
   */
  #readableSpanToRecord(span: ReadableSpan): InsertSpanOptions {
    const spanContext = span.spanContext()

    // Extract Duron-specific attributes
    const jobId = span.attributes['duron.job.id'] as string | undefined
    const stepId = span.attributes['duron.step.id'] as string | undefined

    // Convert attributes to plain object, excluding only job.id and step.id
    // (those are stored in separate columns)
    const attributes: Record<string, any> = {}
    for (const [key, value] of Object.entries(span.attributes)) {
      if (key !== 'duron.job.id' && key !== 'duron.step.id') {
        attributes[key] = value
      }
    }

    // Convert events
    const events = span.events.map((event) => ({
      name: event.name,
      timeUnixNano: this.#hrTimeToNanos(event.time).toString(),
      attributes: event.attributes as Record<string, any> | undefined,
    }))

    // Get parent span ID from parentSpanContext if available
    const parentSpanId = span.parentSpanContext?.spanId || null

    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      parentSpanId,
      jobId: jobId || null,
      stepId: stepId || null,
      name: span.name,
      kind: span.kind as OTelSpanKind,
      startTimeUnixNano: this.#hrTimeToNanos(span.startTime),
      endTimeUnixNano: span.endTime ? this.#hrTimeToNanos(span.endTime) : null,
      statusCode: span.status.code as OTelSpanStatusCode,
      statusMessage: span.status.message || null,
      attributes,
      events,
    }
  }

  /**
   * Convert HrTime [seconds, nanoseconds] to bigint nanoseconds.
   */
  #hrTimeToNanos(hrTime: [number, number]): bigint {
    return BigInt(hrTime[0]) * BigInt(1_000_000_000) + BigInt(hrTime[1])
  }
}
