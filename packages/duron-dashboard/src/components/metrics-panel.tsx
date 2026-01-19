'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import jsonata from 'jsonata'
import { Activity, Clock, Code, Hash, Tag, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useDebounceValue } from 'usehooks-ts'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { type Metric, useJobMetrics, useStepMetrics } from '@/hooks/use-job-metrics'
import { formatDate } from '@/lib/format'
import { JsonView } from './json-view'

interface MetricItemProps {
  metric: Metric
}

function MetricItem({ metric }: MetricItemProps) {
  return (
    <div className="p-3 border rounded-lg space-y-2 bg-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="h-4 w-4 text-primary shrink-0" />
          <span className="font-medium text-sm truncate">{metric.name}</span>
        </div>
        <Badge variant="outline" className="text-xs shrink-0">
          {metric.type}
        </Badge>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <Hash className="h-3 w-3" />
          <span className="font-mono">{metric.value}</span>
        </div>
        <div className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          <span>{formatDate(metric.timestamp)}</span>
        </div>
      </div>

      {Object.keys(metric.attributes).length > 0 && (
        <div className="pt-2 border-t">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <Tag className="h-3 w-3" />
            <span>Attributes</span>
          </div>
          <div className="text-xs">
            <JsonView value={metric.attributes} title="Metric Attributes" height="100px" />
          </div>
        </div>
      )}
    </div>
  )
}

interface VirtualizedMetricsListProps {
  metrics: Metric[]
}

function VirtualizedMetricsList({ metrics }: VirtualizedMetricsListProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: metrics.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100,
    overscan: 5,
  })

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualItem) => {
          const metric = metrics[virtualItem.index]!
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <div className="pb-2">
                <MetricItem metric={metric} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface JsonataResult {
  type: 'metrics' | 'primitive' | 'error' | 'empty'
  metrics?: Metric[]
  primitiveValue?: unknown
  error?: string
}

function isMetricLike(item: unknown): item is Metric {
  return (
    typeof item === 'object' &&
    item !== null &&
    'id' in item &&
    'name' in item &&
    'value' in item &&
    'type' in item &&
    'jobId' in item &&
    'timestamp' in item
  )
}

async function evaluateJsonata(expression: string, metrics: Metric[]): Promise<JsonataResult> {
  if (!expression.trim()) {
    return { type: 'empty' }
  }

  try {
    const compiled = jsonata(expression)
    const result = await compiled.evaluate(metrics)

    // Check if result is undefined/null
    if (result === undefined || result === null) {
      return { type: 'primitive', primitiveValue: result }
    }

    // Check if result is an array
    if (Array.isArray(result)) {
      // Check if it looks like an array of metrics
      const isMetricsArray = result.every(isMetricLike)

      if (isMetricsArray) {
        return { type: 'metrics', metrics: result }
      }

      // It's an array but not metrics - show as primitive
      return { type: 'primitive', primitiveValue: result }
    }

    // Check if it's a single metric object
    if (isMetricLike(result)) {
      return { type: 'metrics', metrics: [result] }
    }

    // It's a primitive value (string, number, boolean, object without metric shape)
    return { type: 'primitive', primitiveValue: result }
  } catch (err) {
    return { type: 'error', error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

interface MetricsModalProps {
  open: boolean
  onClose: () => void
  title: string
  metrics: Metric[]
  total: number
  isLoading: boolean
  error: Error | null
}

function MetricsModal({ open, onClose, title, metrics, total, isLoading, error }: MetricsModalProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery] = useDebounceValue(query, 300)
  const [jsonataResult, setJsonataResult] = useState<JsonataResult>({ type: 'empty' })

  // Evaluate JSONata expression asynchronously
  useEffect(() => {
    let cancelled = false

    evaluateJsonata(debouncedQuery, metrics).then((result) => {
      if (!cancelled) {
        setJsonataResult(result)
      }
    })

    return () => {
      cancelled = true
    }
  }, [metrics, debouncedQuery])

  // Determine which metrics to display
  const displayMetrics = jsonataResult.type === 'metrics' ? jsonataResult.metrics! : metrics

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-4xl! w-[90vw]! h-[85vh]! flex flex-col p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col flex-1 min-h-0 px-6 pb-6 gap-3">
          {/* JSONata Query Input */}
          <div className="relative shrink-0">
            <div className="flex items-center gap-2 mb-1">
              <Code className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">JSONata Query</span>
            </div>
            <Textarea
              placeholder="Enter JSONata expression to filter metrics... e.g. $[name='duron.job.span.end'] or $sum(value)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="font-mono text-sm min-h-[60px] resize-y"
              rows={2}
            />
            {query && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setQuery('')}
                className="absolute right-1 top-7 h-7 w-7 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* JSONata Error Display */}
          {jsonataResult.type === 'error' && (
            <div className="shrink-0 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <div className="text-xs text-destructive font-medium mb-1">JSONata Error</div>
              <div className="text-xs text-destructive/80 font-mono">{jsonataResult.error}</div>
            </div>
          )}

          {/* Primitive Result Display */}
          {jsonataResult.type === 'primitive' && (
            <div className="shrink-0 p-3 bg-primary/10 border border-primary/20 rounded-lg">
              <div className="text-xs text-primary font-medium mb-1">Query Result</div>
              <div className="text-sm font-mono">
                {typeof jsonataResult.primitiveValue === 'object' ? (
                  <JsonView value={jsonataResult.primitiveValue} title="Query Result" height="150px" />
                ) : (
                  String(jsonataResult.primitiveValue)
                )}
              </div>
            </div>
          )}

          {/* Results count */}
          <div className="text-xs text-muted-foreground shrink-0">
            {jsonataResult.type === 'metrics' ? (
              <>
                Showing {displayMetrics.length} of {total} metrics (filtered by query)
              </>
            ) : (
              <>{total} metrics total</>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {isLoading && (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                Loading metrics...
              </div>
            )}

            {error && (
              <div className="h-full flex items-center justify-center text-sm text-destructive">
                Failed to load metrics: {error.message}
              </div>
            )}

            {!isLoading && !error && displayMetrics.length === 0 && (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground italic">
                {query ? 'No metrics match your query' : 'No metrics recorded'}
              </div>
            )}

            {!isLoading && !error && displayMetrics.length > 0 && (
              <div className="h-full p-3">
                <VirtualizedMetricsList metrics={displayMetrics} />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface JobMetricsModalProps {
  jobId: string | null
  open: boolean
  onClose: () => void
}

export function JobMetricsModal({ jobId, open, onClose }: JobMetricsModalProps) {
  const { data, isLoading, error } = useJobMetrics({ jobId, enabled: open && !!jobId })

  return (
    <MetricsModal
      open={open}
      onClose={onClose}
      title="Job Metrics"
      metrics={data?.metrics ?? []}
      total={data?.total ?? 0}
      isLoading={isLoading}
      error={error}
    />
  )
}

interface StepMetricsModalProps {
  stepId: string | null
  open: boolean
  onClose: () => void
}

export function StepMetricsModal({ stepId, open, onClose }: StepMetricsModalProps) {
  const { data, isLoading, error } = useStepMetrics({ stepId, enabled: open && !!stepId })

  return (
    <MetricsModal
      open={open}
      onClose={onClose}
      title="Step Metrics"
      metrics={data?.metrics ?? []}
      total={data?.total ?? 0}
      isLoading={isLoading}
      error={error}
    />
  )
}
