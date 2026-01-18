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
// Noop Telemetry Adapter
// ============================================================================

/**
 * No-operation telemetry adapter.
 * Used when telemetry is disabled. All methods are no-ops.
 */
export class NoopTelemetryAdapter extends TelemetryAdapter {
  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  protected async _start(): Promise<void> {
    // No-op
  }

  protected async _stop(): Promise<void> {
    // No-op
  }

  // ============================================================================
  // Span Methods
  // ============================================================================

  protected async _startJobSpan(options: StartJobSpanOptions): Promise<Span> {
    return {
      id: 'noop',
      jobId: options.jobId,
      stepId: null,
      parentSpanId: null,
    }
  }

  protected async _endJobSpan(_span: Span, _options: EndSpanOptions): Promise<void> {
    // No-op
  }

  protected async _startStepSpan(options: StartStepSpanOptions): Promise<Span> {
    return {
      id: 'noop',
      jobId: options.jobId,
      stepId: options.stepId,
      parentSpanId: options.parentSpan?.id ?? null,
    }
  }

  protected async _endStepSpan(_span: Span, _options: EndSpanOptions): Promise<void> {
    // No-op
  }

  protected async _startDatabaseSpan(_options: StartDatabaseSpanOptions): Promise<Span | null> {
    return null
  }

  protected async _endDatabaseSpan(_span: Span, _options: EndSpanOptions): Promise<void> {
    // No-op
  }

  // ============================================================================
  // Metrics Methods
  // ============================================================================

  protected async _recordMetric(_options: RecordMetricOptions): Promise<void> {
    // No-op
  }

  protected async _addSpanEvent(_options: AddSpanEventOptions): Promise<void> {
    // No-op
  }

  protected async _addSpanAttribute(_options: AddSpanAttributeOptions): Promise<void> {
    // No-op
  }
}

/**
 * Create a no-operation telemetry adapter.
 * Use this when telemetry should be disabled.
 *
 * @returns NoopTelemetryAdapter instance
 */
export const noopTelemetryAdapter = () => new NoopTelemetryAdapter()
