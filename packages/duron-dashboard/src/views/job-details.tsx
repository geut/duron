'use client'

import { List, MoreVertical, Play, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { useJobStatusPolling } from '@/hooks/use-job-status-polling'
import { useCancelJob, useDeleteJob, useJob, useRetryJob } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { BadgeStatus } from '../components/badge-status'
import { JsonView } from '../components/json-view'
import { isExpiring } from '../lib/is-expiring'

interface JobDetailsProps {
  jobId: string | null
  onOpenStepList?: () => void
}

export function JobDetails({ jobId, onOpenStepList }: JobDetailsProps) {
  const { data: job, isLoading: jobLoading } = useJob(jobId)

  // Enable polling for job status updates - refetches entire job detail when status changes
  useJobStatusPolling(jobId, true)

  const cancelMutation = useCancelJob()
  const retryMutation = useRetryJob()
  const deleteMutation = useDeleteJob()

  // Calculate job duration in technical format (HH:MM:SS.mmm)
  const getJobDuration = useCallback((jobData: typeof job) => {
    if (!jobData?.startedAt) {
      return 'Not started'
    }
    const startTime = new Date(jobData.startedAt).getTime()
    const endTime = jobData.finishedAt ? new Date(jobData.finishedAt).getTime() : Date.now()
    const durationMs = endTime - startTime

    const hours = Math.floor(durationMs / 3600000)
    const minutes = Math.floor((durationMs % 3600000) / 60000)
    const seconds = Math.floor((durationMs % 60000) / 1000)
    const milliseconds = durationMs % 1000

    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`
    }
    if (minutes > 0) {
      return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`
    }
    return `${seconds}.${milliseconds.toString().padStart(3, '0')}s`
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
    <ScrollArea className="h-full flex flex-col">
      <div className="p-4 pt-5 space-y-4">
        <div className="flex items-center justify-end">
          {/* Mobile: Dropdown menu and Step List button */}
          <div className="md:hidden flex items-center gap-2">
            {onOpenStepList && (
              <Button variant="outline" size="sm" onClick={onOpenStepList} title="View Steps">
                <List className="h-4 w-4" />
              </Button>
            )}
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
          </div>
          {/* Desktop: Individual buttons */}
          <div className="hidden md:flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              disabled={retryMutation.isPending || cancelMutation.isPending}
            >
              <Play className="h-4 w-4 mr-1" />
              Retry
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={
                cancelMutation.isPending ||
                retryMutation.isPending ||
                job.status === 'completed' ||
                job.status === 'failed' ||
                job.status === 'cancelled'
              }
            >
              <X className="h-4 w-4 mr-1" />
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={
                job.status === 'active' ||
                cancelMutation.isPending ||
                retryMutation.isPending ||
                deleteMutation.isPending
              }
            >
              <X className="h-4 w-4 mr-1" />
              Delete
            </Button>
          </div>
        </div>

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
              <span className="font-medium">Client ID:</span> <span className="font-mono text-xs">{job.clientId}</span>
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
          {job.startedAt && (
            <div>
              <span className="font-medium">Duration:</span> {jobDuration}
            </div>
          )}
          {job.concurrencyLimit && (
            <div>
              <span className="font-medium">Concurrency Limit:</span> {job.concurrencyLimit}
            </div>
          )}
          {job.timeoutMs && (
            <div>
              <span className="font-medium">Timeout:</span> {job.timeoutMs}ms
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
              <div className="p-3 border rounded">
                <JsonView value={job.input} />
              </div>
            </div>
          )}

          {!job.input && <div className="text-sm text-muted-foreground italic">No input available</div>}

          {job.error && (
            <div>
              <div className="font-medium text-destructive mb-1">Error</div>
              <div className="border rounded p-3">
                <JsonView value={job.error} />
              </div>
            </div>
          )}

          {job.output && (
            <div>
              <div className="font-medium mb-1">Output</div>
              <div className="p-3 border rounded">
                <JsonView value={job.output} />
              </div>
            </div>
          )}

          {!job.output && <div className="text-sm text-muted-foreground italic">No output available</div>}
        </div>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}
