'use client'

import { Menu } from 'lucide-react'
import { useState } from 'react'

import { Timeline } from '@/components/timeline'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useStepsPolling } from '@/hooks/use-steps-polling'
import { useJob, useJobSteps } from '@/lib/api'
import { StepDetailsContent } from '@/views/step-details-content'

interface TimelineModalProps {
  jobId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TimelineModal({ jobId, open, onOpenChange }: TimelineModalProps) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const { data: job, isLoading: jobLoading } = useJob(jobId)
  const { data: stepsData, isLoading: stepsLoading } = useJobSteps(jobId, {
    page: 1,
    pageSize: 1000, // Get all steps for timeline
  })

  // Enable polling for step updates
  useStepsPolling(jobId, open)

  const steps = stepsData?.steps ?? []
  const isLoading = jobLoading || stepsLoading

  // Reset selected step when modal closes
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setSelectedStepId(null)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[98vw]! sm:max-w-[98vw]! w-[98vw]! max-h-[98vh]! h-[98vh]! flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Menu className="h-5 w-5" />
            <DialogTitle>Timeline</DialogTitle>
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          {/* Timeline Section */}
          <div className={`overflow-hidden p-6 min-h-0 ${selectedStepId ? 'max-h-[50%] border-b' : 'flex-1'}`}>
            {isLoading ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">Loading timeline...</div>
            ) : (
              <Timeline
                job={job ?? null}
                steps={steps}
                selectedStepId={selectedStepId}
                onStepSelect={setSelectedStepId}
              />
            )}
          </div>

          {/* Step Details Section */}
          {selectedStepId && (
            <>
              <Separator />
              <ScrollArea className="flex-1 min-h-0">
                <div className="p-6">
                  <StepDetailsContent stepId={selectedStepId} jobId={jobId} />
                </div>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
