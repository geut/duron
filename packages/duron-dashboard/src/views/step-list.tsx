'use client'

import clsx from 'clsx'
import { Clock, GitBranch, History, List, Search } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useDebounceValue } from 'usehooks-ts'

import { Timeline } from '@/components/timeline'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useStepView } from '@/contexts/layout-context'
import { useStepsPolling } from '@/hooks/use-steps-polling'
import { type GetJobStepsResponse, useJob, useJobSteps, useTimeTravelJob } from '@/lib/api'
import { calculateDurationSeconds, formatDurationSeconds } from '@/lib/duration'
import { BadgeStatus } from '../components/badge-status'

// Colors for nesting level indicators (cycles after 6 levels)
const NESTING_COLORS = ['bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-orange-500', 'bg-pink-500', 'bg-cyan-500']

/**
 * Get the color class for a given nesting depth
 */
function getNestingColor(depth: number): string {
  return NESTING_COLORS[(depth - 1) % NESTING_COLORS.length] ?? NESTING_COLORS[0]!
}

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
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearchTerm] = useDebounceValue(searchTerm, 300)
  const { viewType, setViewType } = useStepView()

  // Fetch all steps (no pagination)
  const { data: stepsData, isLoading: stepsLoading } = useJobSteps(jobId, {
    search: debouncedSearchTerm || undefined,
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
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
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
                  {searchTerm ? 'No steps found matching your search' : 'No steps found'}
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
                    const isParallel = (step as any).parallel === true
                    const duration = calculateDurationSeconds(step.startedAt, step.finishedAt)

                    // Calculate left margin based on depth (16px per level)
                    const marginLeft = depth * 16

                    return (
                      <AccordionItem
                        key={step.id}
                        value={step.id}
                        className={clsx(depth === 0 && 'border-b')}
                        style={{ marginLeft }}
                      >
                        <div className="flex">
                          {/* Nesting level indicator - colored line for current depth */}
                          {depth > 0 && (
                            <div className="relative w-1 shrink-0" aria-hidden="true">
                              <div className={clsx('w-1 h-full opacity-60', getNestingColor(depth))} />
                            </div>
                          )}
                          <div className={clsx('flex-1 min-w-0', depth > 0 && 'ml-2')}>
                            <AccordionTrigger className="hover:no-underline w-full">
                              <div className="flex items-center justify-between w-full pr-4 min-w-0 overflow-hidden">
                                <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
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
                                  <span className="text-sm font-mono text-muted-foreground shrink-0">
                                    #{stepNumber}
                                  </span>
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
                          </div>
                        </div>
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
