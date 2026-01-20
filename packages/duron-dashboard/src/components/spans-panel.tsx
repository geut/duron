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
import { type Span, useJobSpans, useStepSpans } from '@/hooks/use-job-spans'
import { formatDate } from '@/lib/format'
import { JsonView } from './json-view'

const SpanKindLabels: Record<number, string> = {
  0: 'INTERNAL',
  1: 'SERVER',
  2: 'CLIENT',
  3: 'PRODUCER',
  4: 'CONSUMER',
}

const SpanStatusLabels: Record<number, string> = {
  0: 'UNSET',
  1: 'OK',
  2: 'ERROR',
}

interface SpanItemProps {
  span: Span
}

function nanosToDate(nanos: string | null): Date | null {
  if (!nanos) return null
  // Convert nanoseconds to milliseconds
  const ms = Number(BigInt(nanos) / BigInt(1_000_000))
  return new Date(ms)
}

function SpanItem({ span }: SpanItemProps) {
  const durationNs =
    span.endTimeUnixNano && span.startTimeUnixNano
      ? BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)
      : null
  const durationMs = durationNs ? Number(durationNs / BigInt(1_000_000)) : null
  const startTime = nanosToDate(span.startTimeUnixNano)

  return (
    <div className="p-3 border rounded-lg space-y-2 bg-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="h-4 w-4 text-primary shrink-0" />
          <span className="font-medium text-sm truncate">{span.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs shrink-0">
            {SpanKindLabels[span.kind] ?? 'UNKNOWN'}
          </Badge>
          <Badge
            variant={span.statusCode === 2 ? 'destructive' : span.statusCode === 1 ? 'default' : 'secondary'}
            className="text-xs shrink-0"
          >
            {SpanStatusLabels[span.statusCode] ?? 'UNKNOWN'}
          </Badge>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
        {durationMs !== null && (
          <div className="flex items-center gap-1">
            <Hash className="h-3 w-3" />
            <span className="font-mono">{durationMs}ms</span>
          </div>
        )}
        {startTime && (
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            <span>{formatDate(startTime.toISOString())}</span>
          </div>
        )}
        <div className="flex items-center gap-1 text-muted-foreground/70">
          <span className="font-mono text-[10px] truncate max-w-[120px]" title={span.traceId}>
            trace: {span.traceId.slice(0, 8)}...
          </span>
        </div>
      </div>

      {span.statusMessage && (
        <div className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded">{span.statusMessage}</div>
      )}

      {span.attributes && Object.keys(span.attributes).length > 0 && (
        <div className="pt-2 border-t">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <Tag className="h-3 w-3" />
            <span>Attributes</span>
          </div>
          <div className="text-xs">
            <JsonView value={span.attributes} title="Span Attributes" height="100px" />
          </div>
        </div>
      )}

      {span.events && span.events.length > 0 && (
        <div className="pt-2 border-t">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <Activity className="h-3 w-3" />
            <span>Events ({span.events.length})</span>
          </div>
          <div className="text-xs">
            <JsonView value={span.events} title="Span Events" height="100px" />
          </div>
        </div>
      )}
    </div>
  )
}

interface VirtualizedSpansListProps {
  spans: Span[]
}

function VirtualizedSpansList({ spans }: VirtualizedSpansListProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: spans.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
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
          const span = spans[virtualItem.index]!
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
                <SpanItem span={span} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface JsonataResult {
  type: 'spans' | 'primitive' | 'error' | 'empty'
  spans?: Span[]
  primitiveValue?: unknown
  error?: string
}

function isSpanLike(item: unknown): item is Span {
  return (
    typeof item === 'object' &&
    item !== null &&
    'id' in item &&
    'name' in item &&
    'traceId' in item &&
    'spanId' in item &&
    'kind' in item
  )
}

async function evaluateJsonata(expression: string, spans: Span[]): Promise<JsonataResult> {
  if (!expression.trim()) {
    return { type: 'empty' }
  }

  try {
    const compiled = jsonata(expression)
    const result = await compiled.evaluate(spans)

    // Check if result is undefined/null
    if (result === undefined || result === null) {
      return { type: 'primitive', primitiveValue: result }
    }

    // Check if result is an array
    if (Array.isArray(result)) {
      // Check if it looks like an array of spans
      const isSpansArray = result.every(isSpanLike)

      if (isSpansArray) {
        return { type: 'spans', spans: result }
      }

      // It's an array but not spans - show as primitive
      return { type: 'primitive', primitiveValue: result }
    }

    // Check if it's a single span object
    if (isSpanLike(result)) {
      return { type: 'spans', spans: [result] }
    }

    // It's a primitive value (string, number, boolean, object without span shape)
    return { type: 'primitive', primitiveValue: result }
  } catch (err) {
    return { type: 'error', error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

interface SpansModalProps {
  open: boolean
  onClose: () => void
  title: string
  spans: Span[]
  total: number
  isLoading: boolean
  error: Error | null
}

function SpansModal({ open, onClose, title, spans, total, isLoading, error }: SpansModalProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery] = useDebounceValue(query, 300)
  const [jsonataResult, setJsonataResult] = useState<JsonataResult>({ type: 'empty' })

  // Evaluate JSONata expression asynchronously
  useEffect(() => {
    let cancelled = false

    evaluateJsonata(debouncedQuery, spans).then((result) => {
      if (!cancelled) {
        setJsonataResult(result)
      }
    })

    return () => {
      cancelled = true
    }
  }, [spans, debouncedQuery])

  // Determine which spans to display
  const displaySpans = jsonataResult.type === 'spans' ? jsonataResult.spans! : spans

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="!max-w-4xl !w-[90vw] !h-[85vh] flex flex-col p-0">
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
              placeholder="Enter JSONata expression to filter spans... e.g. $[name='step:processOrder'] or $[statusCode=2]"
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
            {jsonataResult.type === 'spans' ? (
              <>
                Showing {displaySpans.length} of {total} spans (filtered by query)
              </>
            ) : (
              <>{total} spans total</>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {isLoading && (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                Loading spans...
              </div>
            )}

            {error && (
              <div className="h-full flex items-center justify-center text-sm text-destructive">
                Failed to load spans: {error.message}
              </div>
            )}

            {!isLoading && !error && displaySpans.length === 0 && (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground italic">
                {query ? 'No spans match your query' : 'No spans recorded'}
              </div>
            )}

            {!isLoading && !error && displaySpans.length > 0 && (
              <div className="h-full p-3">
                <VirtualizedSpansList spans={displaySpans} />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface JobSpansModalProps {
  jobId: string | null
  open: boolean
  onClose: () => void
}

export function JobSpansModal({ jobId, open, onClose }: JobSpansModalProps) {
  const { data, isLoading, error } = useJobSpans({ jobId, enabled: open && !!jobId })

  return (
    <SpansModal
      open={open}
      onClose={onClose}
      title="Job Spans"
      spans={data?.spans ?? []}
      total={data?.total ?? 0}
      isLoading={isLoading}
      error={error}
    />
  )
}

interface StepSpansModalProps {
  stepId: string | null
  open: boolean
  onClose: () => void
}

export function StepSpansModal({ stepId, open, onClose }: StepSpansModalProps) {
  const { data, isLoading, error } = useStepSpans({ stepId, enabled: open && !!stepId })

  return (
    <SpansModal
      open={open}
      onClose={onClose}
      title="Step Spans"
      spans={data?.spans ?? []}
      total={data?.total ?? 0}
      isLoading={isLoading}
      error={error}
    />
  )
}
