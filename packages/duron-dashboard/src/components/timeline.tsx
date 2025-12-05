'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { CircleDot, GitBranch } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Job, JobStep } from '@/lib/api'
import { calculateDurationSeconds, formatDurationSeconds } from '@/lib/duration'

interface TimelineItem {
  id: string
  name: string
  type: 'job' | 'step'
  startedAt: Date | string | number | null
  finishedAt: Date | string | number | null | undefined
  status: string
  level: number
}

interface TimelineProps {
  job: Job | null
  steps: Omit<JobStep, 'output'>[]
}

const ROW_HEIGHT = 48

export function Timeline({ job, steps }: TimelineProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  // Build timeline items from job and steps
  const timelineItems = useMemo<TimelineItem[]>(() => {
    if (!job) {
      return []
    }

    const items: TimelineItem[] = []

    // Add job as root item
    items.push({
      id: job.id,
      name: job.actionName,
      type: 'job',
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      status: job.status,
      level: 0,
    })

    // Add steps as children
    const sortedSteps = [...steps].sort((a, b) => {
      const aStart = a.startedAt ? new Date(a.startedAt).getTime() : 0
      const bStart = b.startedAt ? new Date(b.startedAt).getTime() : 0
      return aStart - bStart
    })

    sortedSteps.forEach((step) => {
      items.push({
        id: step.id,
        name: step.name,
        type: 'step',
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        status: step.status,
        level: 1,
      })
    })

    return items
  }, [job, steps])

  // Calculate timeline bounds (earliest start, latest end)
  const timelineBounds = useMemo(() => {
    if (timelineItems.length === 0 || !job?.startedAt) {
      return { startTime: 0, endTime: 1, totalDuration: 1 }
    }

    const jobStartTime = new Date(job.startedAt).getTime()
    let earliestStart = jobStartTime
    let latestEnd = jobStartTime

    timelineItems.forEach((item) => {
      if (item.startedAt) {
        const startTime = new Date(item.startedAt).getTime()
        if (startTime < earliestStart) {
          earliestStart = startTime
        }

        const endTime = item.finishedAt ? new Date(item.finishedAt).getTime() : Date.now()
        if (endTime > latestEnd) {
          latestEnd = endTime
        }
      }
    })

    const totalDuration = (latestEnd - earliestStart) / 1000 // Convert to seconds
    return {
      startTime: earliestStart,
      endTime: latestEnd,
      totalDuration: totalDuration || 1,
    }
  }, [timelineItems, job])

  const virtualizer = useVirtualizer({
    count: timelineItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  // Update durations for active items
  const [_, setNow] = useState(Date.now())
  useEffect(() => {
    const hasActiveItems = timelineItems.some((item) => item.startedAt && !item.finishedAt && item.status === 'active')
    if (!hasActiveItems) {
      return
    }

    const interval = setInterval(() => {
      setNow(Date.now())
    }, 100)

    return () => clearInterval(interval)
  }, [timelineItems])

  if (timelineItems.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">No timeline data available</div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto" ref={parentRef}>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = timelineItems[virtualItem.index]!
            const duration = calculateDurationSeconds(item.startedAt, item.finishedAt)
            const isActive = item.startedAt && !item.finishedAt && item.status === 'active'

            // Calculate relative position and width
            let leftPercentage = 0
            let widthPercentage = 0

            if (item.startedAt && timelineBounds.totalDuration > 0) {
              const itemStartTime = new Date(item.startedAt).getTime()
              const relativeStart = (itemStartTime - timelineBounds.startTime) / 1000 // seconds from timeline start
              leftPercentage = (relativeStart / timelineBounds.totalDuration) * 100

              // Width is based on duration relative to total timeline duration
              widthPercentage = (duration / timelineBounds.totalDuration) * 100

              // Ensure bar doesn't go outside bounds
              if (leftPercentage < 0) {
                widthPercentage += leftPercentage
                leftPercentage = 0
              }
              if (leftPercentage + widthPercentage > 100) {
                widthPercentage = 100 - leftPercentage
              }
            }

            return (
              <div
                key={item.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                className="flex items-center border-b border-border/50 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center w-full px-6 py-3 min-w-0 gap-4">
                  {/* Left side: Tree structure with icons and labels - fixed width */}
                  <div
                    className="flex items-center gap-3 min-w-0 flex-[0_0_300px]"
                    style={{ paddingLeft: `${item.level * 20}px` }}
                  >
                    {item.type === 'job' ? (
                      <GitBranch className="h-4 w-4 text-teal-500 shrink-0" />
                    ) : (
                      <CircleDot className="h-4 w-4 text-teal-500 shrink-0" />
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild={true}>
                        <span className="text-sm font-medium text-foreground truncate block min-w-0">{item.name}</span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{item.name}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  {/* Right side: Duration and progress bar - takes remaining space */}
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="text-sm text-muted-foreground min-w-[90px] text-right font-mono shrink-0">
                      {formatDurationSeconds(duration)}
                    </div>
                    <div className="flex-1 h-3 bg-muted/50 rounded-sm overflow-hidden relative min-w-0">
                      {widthPercentage > 0 && (
                        <div
                          className={`h-full absolute transition-all duration-100 ${
                            isActive ? 'bg-teal-500' : duration > 0 ? 'bg-teal-500/80' : 'bg-muted'
                          }`}
                          style={{
                            left: `${leftPercentage}%`,
                            width: `${Math.max(widthPercentage, 0.5)}%`,
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
