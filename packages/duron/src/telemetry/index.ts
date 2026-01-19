// Re-export telemetry adapters and types

export {
  type AddSpanAttributeOptions,
  type AddSpanEventOptions,
  type EndSpanOptions,
  type ObserveContext,
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
export { LocalTelemetryAdapter, type LocalTelemetryAdapterOptions, localTelemetryAdapter } from './local.js'
export { NoopTelemetryAdapter, noopTelemetryAdapter } from './noop.js'
export { OpenTelemetryAdapter, type OpenTelemetryAdapterOptions, openTelemetryAdapter } from './opentelemetry.js'
