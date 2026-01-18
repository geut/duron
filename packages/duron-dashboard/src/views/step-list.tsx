'use client'

import { ChevronRight, Clock, GitBranch, History, List, Search } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { Timeline } from '@/components/timeline'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useStepView } from '@/contexts/layout-context'
import { useDebouncedCallback } from '@/hooks/use-debounced-callback'
import { useStepsPolling } from '@/hooks/use-steps-polling'
import { type GetJobStepsResponse, useJob, useJobSteps, useTimeTravelJob } from '@/lib/api'
import { calculateDurationSeconds, formatDurationSeconds } from '@/lib/duration'
import { BadgeStatus } from '../components/badge-status'

// Step type from the API response (without output field)
type JobStepWithoutOutput = GetJobStepsResponse['steps'][number] & { parentStepId?: string | null; parallel?: boolean }

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
  const { viewType, setViewType } = useStepView()

  // Debounce the search term update with 1000ms delay
  const debouncedSetSearchTerm = useDebouncedCallback((value: string) => {
    setSearchTerm(value)
  }, 1000)

  const handleSearchChange = useCallback(
    (value: string) => {
      setInputValue(value)
      debouncedSetSearchTerm(value)
    },
    [debouncedSetSearchTerm],
  )

  // Fetch all steps (no pagination)
  const { data: stepsData, isLoading: stepsLoading } = useJobSteps(jobId, {
    search: searchTerm || undefined,
  })

  const { data: job } = useJob(jobId)
  const timeTravelMutation = useTimeTravelJob()

  const toggleViewType = useCallback(() => {
    setViewType(viewType === 'list' ? 'timeline' : 'list')
  }, [viewType, setViewType])

  // Check if job is in a terminal state (can time travel)
  const canTimeTravel = job?.status === 'completed' || job?.status === 'failed' || job?.status === 'cancelled'

  const handleTimeTravel = useCallback(
    (stepId: string, e: React.MouseEvent) => {
      e.stopPropagation()
      if (!jobId || !canTimeTravel) return
      timeTravelMutation.mutate({ jobId, stepId })
    },
    [jobId, canTimeTravel, timeTravelMutation],
  )

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
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 min-h-12 border-b shrink-0 flex items-center">
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
          <Tooltip>
            <TooltipTrigger asChild={true}>
              <Button variant="outline" size="sm" onClick={toggleViewType} className="shrink-0">
                {viewType === 'list' ? (
                  <>
                    <Clock className="h-4 w-4" />
                    <span className="hidden sm:inline ml-1">Timeline</span>
                  </>
                ) : (
                  <>
                    <List className="h-4 w-4" />
                    <span className="hidden sm:inline ml-1">List</span>
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Switch to {viewType === 'list' ? 'timeline' : 'list'} view</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {viewType === 'timeline' ? (
          <Timeline job={job ?? null} steps={steps} selectedStepId={selectedStepId} onStepSelect={onStepSelect} />
        ) : (
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
                    const stepNumber = index + 1
                    const isNested = depth > 0
                    const isParallel = (step as any).parallel === true
                    // Calculate left padding based on depth (16px per level)
                    const paddingLeft = depth * 16
                    const duration = calculateDurationSeconds(step.startedAt, step.finishedAt)

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
                              {isParallel && (
                                <Tooltip>
                                  <TooltipTrigger asChild={true}>
                                    <GitBranch className="h-3 w-3 text-blue-500 shrink-0" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Parallel step (independent from siblings)</p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              <span className="text-sm font-mono text-muted-foreground shrink-0">#{stepNumber}</span>
                              <span className="font-medium truncate w-0 grow">{step.name}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-xs font-mono text-muted-foreground">
                                {formatDurationSeconds(duration)}
                              </span>
                              {canTimeTravel && (
                                <Tooltip>
                                  <TooltipTrigger asChild={true}>
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-accent hover:text-accent-foreground cursor-pointer"
                                      onClick={(e) => handleTimeTravel(step.id, e)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          handleTimeTravel(step.id, e as unknown as React.MouseEvent)
                                        }
                                      }}
                                      aria-disabled={timeTravelMutation.isPending}
                                    >
                                      <History className="h-3 w-3" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Time travel: restart from this step</p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              <BadgeStatus status={step.status} justIcon={true} />
                            </div>
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
        )}
      </div>
    </div>
  )
}
