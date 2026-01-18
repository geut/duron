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
}
