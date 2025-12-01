'use client'

import { Search } from 'lucide-react'
import { useCallback, useState } from 'react'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Input } from '@/components/ui/input'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { useDebouncedCallback } from '@/hooks/use-debounced-callback'
import { useStepsPolling } from '@/hooks/use-steps-polling'
import { useJobSteps } from '@/lib/api'
import { BadgeStatus } from '../components/badge-status'
import { StepDetailsContent } from './step-details-content'

interface StepListProps {
  jobId: string | null
  selectedStepId: string | null
  onStepSelect: (stepId: string) => void
}

export function StepList({ jobId, selectedStepId, onStepSelect }: StepListProps) {
  const [inputValue, setInputValue] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 20

  // Debounce the search term update with 1000ms delay
  const debouncedSetSearchTerm = useDebouncedCallback((value: string) => {
    setSearchTerm(value)
    setPage(1) // Reset to first page when searching
  }, 1000)

  const handleSearchChange = useCallback(
    (value: string) => {
      setInputValue(value)
      debouncedSetSearchTerm(value)
    },
    [debouncedSetSearchTerm],
  )

  const { data: stepsData, isLoading: stepsLoading } = useJobSteps(jobId, {
    page,
    pageSize,
    search: searchTerm || undefined,
  })

  // Enable polling for step updates
  useStepsPolling(jobId, true)

  if (!jobId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">Select a job to view steps</div>
    )
  }

  const steps = stepsData?.steps ?? []

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 border-b shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search steps..."
            value={inputValue}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <ScrollArea className="h-full flex-1">
        <div className="p-4">
          {stepsLoading ? (
            <div className="p-4 text-center text-muted-foreground">Loading steps...</div>
          ) : steps.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground">
              {inputValue ? 'No steps found matching your search' : 'No steps found'}
            </div>
          ) : (
            <Accordion
              type="single"
              collapsible={true}
              value={selectedStepId || undefined}
              onValueChange={onStepSelect}
            >
              {steps.map((step, index) => {
                const stepNumber = (page - 1) * pageSize + index + 1
                return (
                  <AccordionItem key={step.id} value={step.id} className="border-b">
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex items-center justify-between w-full pr-4">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-mono text-muted-foreground">#{stepNumber}</span>
                          <span className="font-medium">{step.name}</span>
                        </div>
                        <BadgeStatus status={step.status} />
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <StepDetailsContent stepId={step.id} jobId={jobId} />
                    </AccordionContent>
                  </AccordionItem>
                )
              })}
            </Accordion>
          )}

          {stepsData && stepsData.total > pageSize && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <div className="text-sm text-muted-foreground">
                Showing {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, stepsData.total)} of {stepsData.total}{' '}
                steps
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-50"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page * pageSize >= stepsData.total}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}
