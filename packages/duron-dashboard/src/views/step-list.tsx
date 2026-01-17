'use client'

import { ChevronRight, Clock, Search } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { TimelineModal } from '@/components/timeline-modal'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDebouncedCallback } from '@/hooks/use-debounced-callback'
import { useStepsPolling } from '@/hooks/use-steps-polling'
import { type GetJobStepsResponse, useJobSteps } from '@/lib/api'
import { BadgeStatus } from '../components/badge-status'

// Step type from the API response (without output field)
type JobStepWithoutOutput = GetJobStepsResponse['steps'][number] & { parentStepId?: string | null }

import { StepDetailsContent } from './step-details-content'

interface StepListProps {
  jobId: string | null
  selectedStepId: string | null
  onStepSelect: (stepId: string) => void
}

interface StepNode {
  step: JobStepWithoutOutput
  children: StepNode[]
  depth: number
}

/**
 * Build a tree structure from flat steps list using parentStepId
 */
function buildStepTree(steps: JobStepWithoutOutput[]): StepNode[] {
  const stepMap = new Map<string, StepNode>()
  const rootNodes: StepNode[] = []

  // First pass: create nodes for all steps
  for (const step of steps) {
    stepMap.set(step.id, { step, children: [], depth: 0 })
  }

  // Second pass: build parent-child relationships
  for (const step of steps) {
    const node = stepMap.get(step.id)!
    const parentStepId = (step as any).parentStepId as string | null

    if (parentStepId && stepMap.has(parentStepId)) {
      const parentNode = stepMap.get(parentStepId)!
      parentNode.children.push(node)
      node.depth = parentNode.depth + 1
    } else {
      // Root step (no parent or parent not in current view)
      rootNodes.push(node)
    }
  }

  return rootNodes
}

/**
 * Flatten tree back to ordered list with depth info for rendering
 */
function flattenStepTree(nodes: StepNode[]): Array<{ step: JobStepWithoutOutput; depth: number }> {
  const result: Array<{ step: JobStepWithoutOutput; depth: number }> = []

  function traverse(node: StepNode) {
    result.push({ step: node.step, depth: node.depth })
    for (const child of node.children) {
      traverse(child)
    }
  }

  for (const node of nodes) {
    traverse(node)
  }

  return result
}

export function StepList({ jobId, selectedStepId, onStepSelect }: StepListProps) {
  const [inputValue, setInputValue] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [page, setPage] = useState(1)
  const [timelineOpen, setTimelineOpen] = useState(false)
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

  const steps = stepsData?.steps ?? []

  // Build tree structure and flatten for rendering with depth info
  const orderedSteps = useMemo(() => {
    if (steps.length === 0) return []
    const tree = buildStepTree(steps)
    return flattenStepTree(tree)
  }, [steps])

  if (!jobId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">Select a job to view steps</div>
    )
  }

  return (
    <>
      <div className="h-full flex flex-col overflow-hidden">
        <div className="p-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search steps..."
                value={inputValue}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-8"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTimelineOpen(true)}
              className="shrink-0"
              title="View Timeline"
            >
              <Clock className="h-4 w-4" />
              Timeline
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full [&_[data-radix-scroll-area-viewport]>:first-child]:block!">
            <div className="p-4">
              {stepsLoading ? (
                <div className="p-4 text-center text-muted-foreground">Loading steps...</div>
              ) : orderedSteps.length === 0 ? (
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
                  {orderedSteps.map(({ step, depth }, index) => {
                    const stepNumber = (page - 1) * pageSize + index + 1
                    const isNested = depth > 0
                    // Calculate left padding based on depth (16px per level)
                    const paddingLeft = depth * 16

                    return (
                      <AccordionItem
                        key={step.id}
                        value={step.id}
                        className="border-b"
                        style={{ marginLeft: paddingLeft }}
                      >
                        <AccordionTrigger className="hover:no-underline w-full">
                          <div className="flex items-center justify-between w-full pr-4 min-w-0 overflow-hidden">
                            <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                              {isNested && <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0 -ml-1" />}
                              <span className="text-sm font-mono text-muted-foreground shrink-0">#{stepNumber}</span>
                              <span className="font-medium truncate w-0 grow">{step.name}</span>
                            </div>
                            <BadgeStatus status={step.status} justIcon={true} />
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
            </div>
          </ScrollArea>
        </div>
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
      <TimelineModal jobId={jobId} open={timelineOpen} onOpenChange={setTimelineOpen} />
    </>
  )
}
