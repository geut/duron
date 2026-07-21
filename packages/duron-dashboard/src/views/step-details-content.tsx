'use client'

import { useCallback, useEffect, useState } from 'react'

import { JsonView } from '@/components/json-view'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useStepStatusPolling } from '@/hooks/use-step-status-polling'
import { useStep } from '@/lib/api'
import { calculateDurationMs, formatMs } from '@/lib/duration'
import { formatDate } from '@/lib/format'

import { BadgeStatus } from '../components/badge-status'
import { isExpiring } from '../lib/is-expiring'

interface StepDetailsContentProps {
  stepId: string
  jobId: string | null
}

export function StepDetailsContent({ stepId, jobId }: StepDetailsContentProps) {
  // Fetch the full step data including output
  const { data: step, isLoading, error } = useStep(stepId)

  // Enable polling for individual step status updates
  useStepStatusPolling(stepId, jobId, true)

  // Calculate step duration in hh:mm:ss format (or hh:mm:ss.mmm if < 1 second)
  const getStepDuration = useCallback((stepData: typeof step) => {
    if (!stepData?.startedAt) {
      return 'Not started'
    }
    const durationMs = calculateDurationMs(stepData.startedAt, stepData.finishedAt)
    return formatMs(durationMs)
  }, [])

  const [stepDuration, setStepDuration] = useState(() => getStepDuration(step))

  // Update duration every second if step is still running
  useEffect(() => {
    if (!step) {
      setStepDuration('Not started')
      return
    }

    if (step.finishedAt) {
      setStepDuration(getStepDuration(step))
      return
    }

    // Step is still running, update duration every second
    const interval = setInterval(() => {
      setStepDuration(getStepDuration(step))
    }, 1000)

    return () => clearInterval(interval)
  }, [step, getStepDuration])

  if (isLoading) {
    return <div className="p-4 text-center text-muted-foreground">Loading step details...</div>
  }

  if (error) {
    return (
      <div className="p-4 text-center text-destructive">
        <div className="font-medium mb-2">Error loading step</div>
        <div className="text-sm">{error instanceof Error ? error.message : 'Unknown error'}</div>
      </div>
    )
  }

  if (!step) {
    return <div className="p-4 text-center text-destructive">Step not found</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="space-y-2 text-sm">
          <div>
            <span className="font-medium">ID:</span>{' '}
            <Tooltip>
              <TooltipTrigger asChild={true}>
                <span className="font-mono text-xs cursor-help">
                  {step.id.split('-').pop() || step.id}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-mono text-xs">{step.id}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="text-wrap break-all">
            <span className="font-medium">Step:</span> {step.name}
          </div>
          <div>
            <span className="font-medium">Job ID:</span>{' '}
            <Tooltip>
              <TooltipTrigger asChild={true}>
                <span className="font-mono text-xs cursor-help">
                  {step.jobId.split('-').pop() || step.jobId}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-mono text-xs">{step.jobId}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div>
            <span className="font-medium">Status:</span> <BadgeStatus status={step.status} />
          </div>
          <div>
            <span className="font-medium">Started:</span> {formatDate(step.startedAt)}
          </div>
          {step.finishedAt && (
            <div>
              <span className="font-medium">Finished:</span> {formatDate(step.finishedAt)}
            </div>
          )}
          <div>
            <span className="font-medium">Duration:</span> {stepDuration}
          </div>
          {step.timeoutMs && (
            <div>
              <span className="font-medium">Timeout:</span> {formatMs(step.timeoutMs)}
            </div>
          )}
          {step.expiresAt && (
            <div>
              <span className="font-medium">Expires:</span>{' '}
              <span
                className={
                  isExpiring({
                    isStep: true,
                    expiresAt: new Date(step.expiresAt),
                    status: step.status,
                    error: step.error,
                  })
                    ? 'text-destructive'
                    : ''
                }
              >
                {formatDate(step.expiresAt)}
              </span>
            </div>
          )}
          <div>
            <span className="font-medium">Retries:</span> {step.retriesCount} / {step.retriesLimit}
            {step.retriesLimit > 0 && (
              <span className="text-muted-foreground ml-1">
                ({Math.max(0, step.retriesLimit - step.retriesCount)} left)
                {step.delayedMs ? `(+${step.delayedMs}ms)` : ''}
              </span>
            )}
          </div>
        </div>
      </div>

      {step.error && (
        <div>
          <div className="font-medium text-destructive mb-1">Error</div>
          <JsonView value={step.error} title="Step Error" />
        </div>
      )}

      {step.output && (
        <div>
          <div className="font-medium mb-1">Output</div>
          <JsonView value={step.output} title="Step Output" />
        </div>
      )}

      {step.historyFailedAttempts && Object.keys(step.historyFailedAttempts).length > 0 && (
        <div>
          <div className="font-medium mb-1">Failed Attempts History</div>
          <div className="space-y-2">
            {Object.entries(step.historyFailedAttempts).map(([key, attempt]) => (
              <div key={key} className="p-2 bg-muted border rounded text-xs">
                <div className="font-medium mb-1">Attempt at {formatDate(attempt.failedAt)}</div>
                <JsonView
                  value={attempt.error}
                  title={`Attempt Error (${formatDate(attempt.failedAt)})`}
                  height="100px"
                />
                {attempt.delayedMs && (
                  <div className="mt-1 text-muted-foreground">Delayed: {attempt.delayedMs}ms</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
