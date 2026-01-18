'use client'

import { Activity, Clock, Hash, Tag } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
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
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">{metric.name}</span>
        </div>
        <Badge variant="outline" className="text-xs">
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

interface JobMetricsPanelProps {
  jobId: string
}

export function JobMetricsPanel({ jobId }: JobMetricsPanelProps) {
  const { data, isLoading, error } = useJobMetrics({ jobId, enabled: true })

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading metrics...</div>
  }

  if (error) {
    return <div className="p-4 text-sm text-destructive">Failed to load metrics: {(error as Error).message}</div>
  }

  if (!data?.metrics || data.metrics.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground italic">No metrics recorded for this job</div>
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Job Metrics
          </h3>
          <span className="text-xs text-muted-foreground">{data.total} total</span>
        </div>
        <div className="space-y-2">
          {data.metrics.map((metric) => (
            <MetricItem key={metric.id} metric={metric} />
          ))}
        </div>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}

interface StepMetricsPanelProps {
  stepId: string
}

export function StepMetricsPanel({ stepId }: StepMetricsPanelProps) {
  const { data, isLoading, error } = useStepMetrics({ stepId, enabled: true })

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading metrics...</div>
  }

  if (error) {
    return <div className="p-4 text-sm text-destructive">Failed to load metrics: {(error as Error).message}</div>
  }

  if (!data?.metrics || data.metrics.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground italic">No metrics recorded for this step</div>
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Step Metrics
          </h3>
          <span className="text-xs text-muted-foreground">{data.total} total</span>
        </div>
        <div className="space-y-2">
          {data.metrics.map((metric) => (
            <MetricItem key={metric.id} metric={metric} />
          ))}
        </div>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}
