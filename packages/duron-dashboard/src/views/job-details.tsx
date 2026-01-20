'use client'

import { Activity, MoreVertical, Play, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { useSpans } from '@/contexts/spans-context'
import { useJobStatusPolling } from '@/hooks/use-job-status-polling'
import { useCancelJob, useDeleteJob, useJob, useRetryJob } from '@/lib/api'
import { calculateDurationMs, formatMs } from '@/lib/duration'
import { formatDate } from '@/lib/format'
import { BadgeStatus } from '../components/badge-status'
import { JsonView } from '../components/json-view'
import { JobSpansModal } from '../components/spans-panel'
import { isExpiring } from '../lib/is-expiring'

interface JobDetailsProps {
  jobId: string | null
  onClose?: () => void
}

export function JobDetails({ jobId, onClose }: JobDetailsProps) {
  const { data: job, isLoading: jobLoading } = useJob(jobId)
  const { spansEnabled } = useSpans()
  const [showSpans, setShowSpans] = useState(false)

  // Enable polling for job status updates - refetches entire job detail when status changes
  useJobStatusPolling(jobId, true)

  const cancelMutation = useCancelJob()
  const retryMutation = useRetryJob()
  const deleteMutation = useDeleteJob()

  // Calculate job duration in hh:mm:ss format (or hh:mm:ss.mmm if < 1 second)
  const getJobDuration = useCallback((jobData: typeof job) => {
    if (!jobData?.startedAt) {
      return 'Not started'
    }
    const durationMs = calculateDurationMs(jobData.startedAt, jobData.finishedAt)
    return formatMs(durationMs)
  }, [])

  const [jobDuration, setJobDuration] = useState(() => getJobDuration(job))

  // Update duration every second if job is still running
  useEffect(() => {
    if (!job) {
      setJobDuration('Not started')
      return
    }

    if (!job.startedAt || job.finishedAt) {
      setJobDuration(getJobDuration(job))
      return
    }

    // Job is still running, update duration every second
    const interval = setInterval(() => {
      setJobDuration(getJobDuration(job))
    }, 1000)

    return () => clearInterval(interval)
  }, [job, getJobDuration])

  if (!jobId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">Select a job to view details</div>
    )
  }

  if (jobLoading) {
    return <div className="p-4">Loading job details...</div>
  }

  if (!job) {
    return <div className="h-full flex items-center justify-center text-destructive">Job not found</div>
  }

  const handleCancel = async () => {
    if (confirm('Are you sure you want to cancel this job?')) {
      await cancelMutation.mutateAsync(jobId)
    }
  }

  const handleRetry = async () => {
    if (confirm('Are you sure you want to retry this job?')) {
      await retryMutation.mutateAsync(jobId)
    }
  }

  const handleDelete = async () => {
    if (job?.status === 'active') {
      alert('Active jobs cannot be deleted')
      return
    }
    if (confirm('Are you sure you want to delete this job? This action cannot be undone.')) {
      try {
        await deleteMutation.mutateAsync(jobId)
      } catch (error: any) {
        alert(error?.message || 'Failed to delete job')
      }
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header with title and action buttons */}
      <div className="px-4 min-h-12 border-b shrink-0 flex items-center justify-between gap-2">
        <h2 className="font-medium shrink-0">Job Details</h2>
        <div className="flex items-center gap-2">
          {/* Action buttons dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild={true}>
              <Button variant="outline" size="sm" disabled={retryMutation.isPending || cancelMutation.isPending}>
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleRetry} disabled={retryMutation.isPending || cancelMutation.isPending}>
                <Play className="h-4 w-4 mr-2" />
                Retry
              </DropdownMenuItem>
              {spansEnabled && (
                <DropdownMenuItem onClick={() => setShowSpans(!showSpans)}>
                  <Activity className="h-4 w-4 mr-2" />
                  {showSpans ? 'Hide Spans' : 'Show Spans'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={handleCancel}
                disabled={
                  cancelMutation.isPending ||
                  retryMutation.isPending ||
                  job.status === 'completed' ||
                  job.status === 'failed' ||
                  job.status === 'cancelled'
                }
                variant="destructive"
              >
                <X className="h-4 w-4 mr-2" />
                Cancel
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleDelete}
                disabled={
                  job.status === 'active' ||
                  cancelMutation.isPending ||
                  retryMutation.isPending ||
                  deleteMutation.isPending
                }
                variant="destructive"
              >
                <X className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Close button */}
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} className="h-6 w-6 p-0" title="Hide Job Details">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          <div className="space-y-2 text-sm">
            <div>
              <span className="font-medium">ID:</span> <span className="font-mono text-xs break-all">{job.id}</span>
            </div>
            <div>
              <span className="font-medium">Action:</span> {job.actionName}
            </div>
            <div>
              <span className="font-medium">Group Key:</span> {job.groupKey}
            </div>
            {job.clientId && (
              <div>
                <span className="font-medium">Client ID:</span>{' '}
                <span className="font-mono text-xs">{job.clientId}</span>
              </div>
            )}
            <div>
              <span className="font-medium">Status:</span> <BadgeStatus status={job.status} />
            </div>
            <div>
              <span className="font-medium">Created:</span> {formatDate(job.createdAt)}
            </div>
            {job.startedAt && (
              <div>
                <span className="font-medium">Started:</span> {formatDate(job.startedAt)}
              </div>
            )}
            {job.finishedAt && (
              <div>
                <span className="font-medium">Completed:</span> {formatDate(job.finishedAt)}
              </div>
            )}
            {job.concurrencyLimit && (
              <div>
                <span className="font-medium">Concurrency Limit:</span> {job.concurrencyLimit}
              </div>
            )}
            {job.startedAt && (
              <div>
                <span className="font-medium">Duration:</span> {jobDuration}
              </div>
            )}
            {job.timeoutMs && (
              <div>
                <span className="font-medium">Timeout:</span> {formatMs(job.timeoutMs)}
              </div>
            )}
            {job.expiresAt && (
              <div>
                <span className="font-medium">Expires:</span>{' '}
                <span
                  className={
                    isExpiring({
                      isStep: false,
                      expiresAt: new Date(job.expiresAt),
                      status: job.status,
                      error: job.error,
                    })
                      ? 'text-destructive'
                      : ''
                  }
                >
                  {formatDate(job.expiresAt)}
                </span>
              </div>
            )}
          </div>

          {/* Job Input/Output */}
          <div className="space-y-4">
            {job.input && (
              <div>
                <div className="font-medium mb-1">Input</div>
                <JsonView value={job.input} title="Job Input" />
              </div>
            )}

            {!job.input && <div className="text-sm text-muted-foreground italic">No input available</div>}

            {job.error && (
              <div>
                <div className="font-medium text-destructive mb-1">Error</div>
                <JsonView value={job.error} title="Job Error" />
              </div>
            )}

            {job.output && (
              <div>
                <div className="font-medium mb-1">Output</div>
                <JsonView value={job.output} title="Job Output" />
              </div>
            )}

            {!job.output && <div className="text-sm text-muted-foreground italic">No output available</div>}
          </div>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      {/* Spans Modal */}
      {spansEnabled && <JobSpansModal jobId={job.id} open={showSpans} onClose={() => setShowSpans(false)} />}
    </div>
  )
}
