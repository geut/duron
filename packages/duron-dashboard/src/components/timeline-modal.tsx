'use client'

import { Menu } from 'lucide-react'

import { Timeline } from '@/components/timeline'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useStepsPolling } from '@/hooks/use-steps-polling'
import { useJob, useJobSteps } from '@/lib/api'

interface TimelineModalProps {
  jobId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TimelineModal({ jobId, open, onOpenChange }: TimelineModalProps) {
  const { data: job, isLoading: jobLoading } = useJob(jobId)
  const { data: stepsData, isLoading: stepsLoading } = useJobSteps(jobId, {
    page: 1,
    pageSize: 1000, // Get all steps for timeline
  })

  // Enable polling for step updates
  useStepsPolling(jobId, open)

  const steps = stepsData?.steps ?? []
  const isLoading = jobLoading || stepsLoading

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[98vw]! sm:max-w-[98vw]! w-[98vw]! max-h-[98vh]! h-[98vh]! flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Menu className="h-5 w-5" />
            <DialogTitle>Timeline</DialogTitle>
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-hidden p-6 min-h-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">Loading timeline...</div>
          ) : (
            <Timeline job={job ?? null} steps={steps} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
