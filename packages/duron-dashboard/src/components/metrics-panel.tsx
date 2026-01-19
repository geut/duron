'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { Activity, Clock, Hash, Search, Tag, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { type Metric, useJobMetrics, useStepMetrics } from '@/hooks/use-job-metrics'
import { formatDate } from '@/lib/format'
import { JsonView } from './json-view'

interface MetricItemProps {
  metric: Metric
  searchTerm: string
}

function highlightText(text: string, searchTerm: string): React.ReactNode {
  if (!searchTerm.trim()) {
    return text
  }

  const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  const parts = text.split(regex)

  return parts.map((part, index) =>
    regex.test(part) ? (
      <mark key={index} className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

function MetricItem({ metric, searchTerm }: MetricItemProps) {
  return (
    <div className="p-3 border rounded-lg space-y-2 bg-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="h-4 w-4 text-primary shrink-0" />
          <span className="font-medium text-sm truncate">{highlightText(metric.name, searchTerm)}</span>
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
            <JsonView value={metric.attributes} />
          </div>
        </div>
      )}
    </div>
  )
}

interface VirtualizedMetricsListProps {
  metrics: Metric[]
  searchTerm: string
}

function VirtualizedMetricsList({ metrics, searchTerm }: VirtualizedMetricsListProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: metrics.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100, // Initial estimate, will be measured dynamically
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
                <MetricItem metric={metric} searchTerm={searchTerm} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
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
  const [searchTerm, setSearchTerm] = useState('')

  // Filter metrics based on search term
  const filteredMetrics = useMemo(() => {
    if (!searchTerm.trim()) {
      return metrics
    }

    const lowerSearch = searchTerm.toLowerCase()
    return metrics.filter((metric) => {
      // Search in name
      if (metric.name.toLowerCase().includes(lowerSearch)) {
        return true
      }
      // Search in type
      if (metric.type.toLowerCase().includes(lowerSearch)) {
        return true
      }
      // Search in value (as string)
      if (String(metric.value).includes(lowerSearch)) {
        return true
      }
      // Search in attributes
      const attributesStr = JSON.stringify(metric.attributes).toLowerCase()
      if (attributesStr.includes(lowerSearch)) {
        return true
      }
      return false
    })
  }, [metrics, searchTerm])

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
          {/* Search Input */}
          <div className="relative shrink-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search metrics by name, type, value, or attributes..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-10"
            />
            {searchTerm && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSearchTerm('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Results count */}
          <div className="text-xs text-muted-foreground shrink-0">
            {searchTerm ? (
              <>
                Showing {filteredMetrics.length} of {total} metrics
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

            {!isLoading && !error && filteredMetrics.length === 0 && (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground italic">
                {searchTerm ? 'No metrics match your search' : 'No metrics recorded'}
              </div>
            )}

            {!isLoading && !error && filteredMetrics.length > 0 && (
              <div className="h-full p-3">
                <VirtualizedMetricsList metrics={filteredMetrics} searchTerm={searchTerm} />
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
