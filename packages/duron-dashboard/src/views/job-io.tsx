'use client'

import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { useJob } from '@/lib/api'
import { JsonView } from '../components/json-view'

interface JobIOProps {
  jobId: string | null
}

export function JobIO({ jobId }: JobIOProps) {
  const { data: job, isLoading } = useJob(jobId)

  if (!jobId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        Select a job to view input/output
      </div>
    )
  }

  if (isLoading) {
    return <div className="p-4">Loading job data...</div>
  }

  if (!job) {
    return <div className="h-full flex items-center justify-center text-destructive">Job not found</div>
  }

  return (
    <ScrollArea className="h-full flex flex-col p-4 pt-5">
      <div className="space-y-4 flex-1">
        {job.input && (
          <div>
            <div className="font-medium mb-1">Input</div>
            <div className="p-3 border rounded">
              <JsonView value={job.input} />
            </div>
          </div>
        )}

        {!job.input && <div className="text-sm text-muted-foreground italic">No input available</div>}

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
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}
