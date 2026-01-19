import type { Logger } from 'pino'

import type { Adapter } from '../adapters/adapter.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Interface representing the minimal Duron client required by telemetry adapters.
 * This avoids circular dependencies by using a minimal interface.
 */
export interface TelemetryClient {
  /**
   * The database adapter instance.
   */
  database: Adapter
}

/**
 * Span represents a trace span for job or step execution.
 */
export interface Span {
  /**
   * Unique identifier for this span.
   */
  id: string

  /**
   * The job ID this span belongs to.
   */
  jobId: string

  /**
   * The step ID this span belongs to (null for job spans).
   */
  stepId: string | null

  /**
   * Parent span ID for nested spans.
   */
  parentSpanId: string | null
}

/**
 * Options for starting a job span.
 */
export interface StartJobSpanOptions {
  jobId: string
  actionName: string
  groupKey: string
  input?: any
}

/**
 * Options for starting a step span.
 */
export interface StartStepSpanOptions {
  jobId: string
  stepId: string
  stepName: string
  parentSpan?: Span
  parentStepId: string | null
}

/**
 * Options for ending a span.
 */
export interface EndSpanOptions {
  status: 'ok' | 'error' | 'cancelled'
  error?: any
}

/**
 * Options for starting a database span.
 */
export interface StartDatabaseSpanOptions {
  operation: string
  query?: string
}

/**
 * Options for recording a metric.
 */
export interface RecordMetricOptions {
  jobId: string
  stepId?: string
  name: string
  value: number
  attributes?: Record<string, any>
}

/**
 * Options for adding a span event.
 */
export interface AddSpanEventOptions {
  span: Span
  name: string
  attributes?: Record<string, any>
}

/**
 * Options for adding a span attribute.
 */
export interface AddSpanAttributeOptions {
  span: Span
  key: string
  value: string | number | boolean
}

/**
 * Options for starting a custom span with the tracer.
 */
export interface StartSpanOptions {
  /**
   * Span kind (internal, client, server, producer, consumer).
   * @default 'internal'
   */
  kind?: 'internal' | 'client' | 'server' | 'producer' | 'consumer'

  /**
   * Initial attributes for the span.
   */
  attributes?: Record<string, string | number | boolean>

  /**
   * Parent span to use for context propagation.
   * If not provided, uses the current active context.
   */
  parentSpan?: TracerSpan
}

/**
 * A span created by the Tracer for manual instrumentation.
 */
export interface TracerSpan {
  /**
   * Set an attribute on the span.
   *
   * @param key - The attribute key
   * @param value - The attribute value
   */
  setAttribute(key: string, value: string | number | boolean): void

  /**
   * Set multiple attributes on the span.
   *
   * @param attributes - The attributes to set
   */
  setAttributes(attributes: Record<string, string | number | boolean>): void

  /**
   * Add an event to the span.
   *
   * @param name - The event name
   * @param attributes - Optional event attributes
   */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void

  /**
   * Record an exception on the span.
   *
   * @param error - The error to record
   */
  recordException(error: Error): void

  /**
   * Set the span status to OK.
   */
  setStatusOk(): void

  /**
   * Set the span status to error.
   *
   * @param message - Optional error message
   */
  setStatusError(message?: string): void

  /**
   * End the span.
   * After calling this, no more operations can be performed on the span.
   */
  end(): void

  /**
   * Check if this span is recording.
   */
  isRecording(): boolean
}

/**
 * A Tracer provides methods for creating spans.
 * Similar to OpenTelemetry's Tracer interface.
 */
export interface Tracer {
  /**
   * The name of this tracer.
   */
  readonly name: string

  /**
   * Start a new span.
   *
   * @param name - The name of the span
   * @param options - Optional span configuration
   * @returns A TracerSpan for manual instrumentation
   */
  startSpan(name: string, options?: StartSpanOptions): TracerSpan
}

/**
 * Observe context provided to action and step handlers.
 */
export interface ObserveContext {
  /**
   * Record a custom metric.
   *
   * @param name - The metric name (e.g., 'ai.tokens.total', 'processing.duration_ms')
   * @param value - The metric value
   * @param attributes - Optional attributes for the metric
   */
  recordMetric(name: string, value: number, attributes?: Record<string, any>): void

  /**
   * Add an attribute to the current span.
   *
   * @param key - The attribute key
   * @param value - The attribute value
   */
  addSpanAttribute(key: string, value: string | number | boolean): void

  /**
   * Add an event to the current span.
   *
   * @param name - The event name
   * @param attributes - Optional event attributes
   */
  addSpanEvent(name: string, attributes?: Record<string, any>): void

  /**
   * Get a tracer for manual instrumentation.
   * Similar to OpenTelemetry's `trace.getTracer()` method.
   *
   * @param name - The name of the tracer (typically your service or library name)
   * @returns A Tracer for creating custom spans
   *
   * @example
   * ```typescript
   * const tracer = ctx.observe.getTracer('my-service')
   *
   * const span = tracer.startSpan('external-api-call', {
   *   kind: 'client',
   *   attributes: { 'api.endpoint': '/users' }
   * })
   *
   * try {
   *   const result = await fetch('https://api.example.com/users')
   *   span.setStatusOk()
   *   return result
   * } catch (error) {
   *   span.recordException(error)
   *   span.setStatusError(error.message)
   *   throw error
   * } finally {
   *   span.end()
   * }
   * ```
   */
  getTracer(name: string): Tracer
}

// ============================================================================
// Abstract Telemetry Adapter
// ============================================================================

/**
 * Abstract base class for telemetry adapters.
 * All telemetry adapters must extend this class and implement its abstract methods.
 */
export abstract class TelemetryAdapter {
  #logger: Logger | null = null
  #client: TelemetryClient | null = null
  #started: boolean = false
  #stopped: boolean = false
  #starting: Promise<boolean> | null = null
  #stopping: Promise<boolean> | null = null

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Start the telemetry adapter.
   * Performs any necessary initialization.
   *
   * @returns Promise resolving to `true` if started successfully, `false` otherwise
   */
  async start(): Promise<boolean> {
    try {
      if (this.#stopping || this.#stopped) {
        return false
      }

      if (this.#started) {
        return true
      }

      if (this.#starting) {
        return this.#starting
      }

      this.#starting = (async () => {
        await this._start()
        this.#started = true
        this.#starting = null
        return true
      })()

      return this.#starting
    } catch (error) {
      this.#logger?.error(error, 'Error in TelemetryAdapter.start()')
      throw error
    }
  }

  /**
   * Stop the telemetry adapter.
   * Performs cleanup.
   *
   * @returns Promise resolving to `true` if stopped successfully, `false` otherwise
   */
  async stop(): Promise<boolean> {
    try {
      if (this.#stopped) {
        return true
      }

      if (this.#stopping) {
        return this.#stopping
      }

      this.#stopping = (async () => {
        await this._stop()
        this.#stopped = true
        this.#stopping = null
        return true
      })()

      return this.#stopping
    } catch (error) {
      this.#logger?.error(error, 'Error in TelemetryAdapter.stop()')
      throw error
    }
  }

  // ============================================================================
  // Configuration Methods
  // ============================================================================

  /**
   * Set the logger instance for this adapter.
   *
   * @param logger - The logger instance to use for logging
   */
  setLogger(logger: Logger): void {
    this.#logger = logger
  }

  /**
   * Get the logger instance for this adapter.
   *
   * @returns The logger instance, or `null` if not set
   */
  get logger(): Logger | null {
    return this.#logger
  }

  /**
   * Set the Duron client instance for this adapter.
   * This is called automatically by the Duron client during initialization.
   *
   * @param client - The Duron client instance
   */
  setClient(client: TelemetryClient): void {
    this.#client = client
  }

  /**
   * Get the Duron client instance.
   * Available to subclasses for accessing the database adapter.
   *
   * @returns The Duron client instance, or `null` if not set
   */
  protected get client(): TelemetryClient | null {
    return this.#client
  }

  // ============================================================================
  // Span Methods
  // ============================================================================

  /**
   * Start a span for job execution.
   *
   * @param options - Options for the job span
   * @returns The created span
   */
  async startJobSpan(options: StartJobSpanOptions): Promise<Span> {
    await this.start()
    return this._startJobSpan(options)
  }

  /**
   * End a job span.
   *
   * @param span - The span to end
   * @param options - End options including status and error
   */
  async endJobSpan(span: Span, options: EndSpanOptions): Promise<void> {
    await this.start()
    return this._endJobSpan(span, options)
  }

  /**
   * Start a span for step execution.
   *
   * @param options - Options for the step span
   * @returns The created span
   */
  async startStepSpan(options: StartStepSpanOptions): Promise<Span> {
    await this.start()
    return this._startStepSpan(options)
  }

  /**
   * End a step span.
   *
   * @param span - The span to end
   * @param options - End options including status and error
   */
  async endStepSpan(span: Span, options: EndSpanOptions): Promise<void> {
    await this.start()
    return this._endStepSpan(span, options)
  }

  /**
   * Start a span for database operation (optional tracing).
   *
   * @param options - Options for the database span
   * @returns The created span, or null if database tracing is disabled
   */
  async startDatabaseSpan(options: StartDatabaseSpanOptions): Promise<Span | null> {
    await this.start()
    return this._startDatabaseSpan(options)
  }

  /**
   * End a database span.
   *
   * @param span - The span to end
   * @param options - End options including status and error
   */
  async endDatabaseSpan(span: Span | null, options: EndSpanOptions): Promise<void> {
    if (!span) return
    await this.start()
    return this._endDatabaseSpan(span, options)
  }

  // ============================================================================
  // Metrics Methods
  // ============================================================================

  /**
   * Record a metric.
   *
   * @param options - Options for recording the metric
   */
  async recordMetric(options: RecordMetricOptions): Promise<void> {
    await this.start()
    return this._recordMetric(options)
  }

  /**
   * Add an event to a span.
   *
   * @param options - Options for the span event
   */
  async addSpanEvent(options: AddSpanEventOptions): Promise<void> {
    await this.start()
    return this._addSpanEvent(options)
  }

  /**
   * Add an attribute to a span.
   *
   * @param options - Options for the span attribute
   */
  async addSpanAttribute(options: AddSpanAttributeOptions): Promise<void> {
    await this.start()
    return this._addSpanAttribute(options)
  }

  // ============================================================================
  // Tracer Methods
  // ============================================================================

  /**
   * Get a tracer for manual instrumentation.
   * Similar to OpenTelemetry's `trace.getTracer()` method.
   *
   * @param name - The name of the tracer (typically your service or library name)
   * @returns A Tracer for creating custom spans
   *
   * @example
   * ```typescript
   * const tracer = telemetry.getTracer('my-service')
   *
   * const span = tracer.startSpan('process-order', {
   *   attributes: { 'order.id': orderId }
   * })
   *
   * try {
   *   // Do some work
   *   span.addEvent('order.validated')
   *   span.setStatusOk()
   * } catch (error) {
   *   span.recordException(error)
   *   span.setStatusError(error.message)
   * } finally {
   *   span.end()
   * }
   * ```
   */
  getTracer(name: string): Tracer {
    return this._getTracer(name)
  }

  // ============================================================================
  // Context Methods
  // ============================================================================

  /**
   * Create an observe context for action/step handlers.
   *
   * @param jobId - The job ID
   * @param stepId - The step ID (optional)
   * @param span - The current span
   * @returns ObserveContext for use in handlers
   */
  createObserveContext(jobId: string, stepId: string | null, span: Span): ObserveContext {
    return {
      recordMetric: (name: string, value: number, attributes?: Record<string, any>) => {
        this.recordMetric({
          jobId,
          stepId: stepId ?? undefined,
          name,
          value,
          attributes,
        }).catch((err) => {
          this.#logger?.error(err, 'Error recording metric')
        })
      },
      addSpanAttribute: (key: string, value: string | number | boolean) => {
        this.addSpanAttribute({ span, key, value }).catch((err) => {
          this.#logger?.error(err, 'Error adding span attribute')
        })
      },
      addSpanEvent: (name: string, attributes?: Record<string, any>) => {
        this.addSpanEvent({ span, name, attributes }).catch((err) => {
          this.#logger?.error(err, 'Error adding span event')
        })
      },
      getTracer: (name: string) => {
        return this.getTracer(name)
      },
    }
  }

  // ============================================================================
  // Protected Abstract Methods (to be implemented by adapters)
  // ============================================================================

  /**
   * Start the adapter.
   */
  protected abstract _start(): Promise<void>

  /**
   * Stop the adapter.
   */
  protected abstract _stop(): Promise<void>

  /**
   * Internal method to start a job span.
   */
  protected abstract _startJobSpan(options: StartJobSpanOptions): Promise<Span>

  /**
   * Internal method to end a job span.
   */
  protected abstract _endJobSpan(span: Span, options: EndSpanOptions): Promise<void>

  /**
   * Internal method to start a step span.
   */
  protected abstract _startStepSpan(options: StartStepSpanOptions): Promise<Span>

  /**
   * Internal method to end a step span.
   */
  protected abstract _endStepSpan(span: Span, options: EndSpanOptions): Promise<void>

  /**
   * Internal method to start a database span.
   */
  protected abstract _startDatabaseSpan(options: StartDatabaseSpanOptions): Promise<Span | null>

  /**
   * Internal method to end a database span.
   */
  protected abstract _endDatabaseSpan(span: Span, options: EndSpanOptions): Promise<void>

  /**
   * Internal method to record a metric.
   */
  protected abstract _recordMetric(options: RecordMetricOptions): Promise<void>

  /**
   * Internal method to add a span event.
   */
  protected abstract _addSpanEvent(options: AddSpanEventOptions): Promise<void>

  /**
   * Internal method to add a span attribute.
   */
  protected abstract _addSpanAttribute(options: AddSpanAttributeOptions): Promise<void>

  /**
   * Internal method to get a tracer for manual instrumentation.
   */
  protected abstract _getTracer(name: string): Tracer
}
