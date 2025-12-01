import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import type { GetJobStepsResponse } from '@/lib/api'
import { useApiRequest } from '@/lib/api'

const POLL_INTERVAL = 2000 // 2 seconds

/**
 * Hook to poll for step updates for a specific job and trigger refetch when updates are detected.
 * Stores the last updated_at timestamp and polls for steps updated after that time.
 */
export function useStepsPolling(jobId: string | null, enabled: boolean = true) {
  const queryClient = useQueryClient()
  const apiRequest = useApiRequest()
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (!enabled || !jobId) {
      return
    }

    // Initialize lastUpdatedAt from the current steps data if available
    const initializeLastUpdated = () => {
      const stepsData = queryClient.getQueryData<GetJobStepsResponse>(['job-steps', jobId])
      if (stepsData?.steps && stepsData.steps.length > 0) {
        // Find the most recent updated_at
        const mostRecent = stepsData.steps.reduce((latest: Date, step) => {
          const stepUpdated = new Date(step.updatedAt)
          return stepUpdated > latest ? stepUpdated : latest
        }, new Date(0))
        if (mostRecent.getTime() > 0) {
          setLastUpdatedAt(mostRecent)
        }
      } else if (lastUpdatedAt === null) {
        // If no steps data and no lastUpdatedAt, set to now minus a small buffer
        setLastUpdatedAt(new Date(Date.now() - 1000))
      }
    }

    // Initialize on mount
    initializeLastUpdated()

    // Poll for updates
    const pollForUpdates = async () => {
      if (!lastUpdatedAt || !jobId) {
        return
      }

      try {
        const queryParams = new URLSearchParams()
        queryParams.set('fUpdatedAfter', lastUpdatedAt.toISOString())
        queryParams.set('pageSize', '1') // We only need to know if there are updates

        const data = await apiRequest<GetJobStepsResponse>(`/jobs/${jobId}/steps?${queryParams.toString()}`)

        if (data.steps.length > 0) {
          // Updates found - update the timestamp and trigger refetch
          const mostRecent = data.steps.reduce((latest: Date, step) => {
            const stepUpdated = new Date(step.updatedAt)
            return stepUpdated > latest ? stepUpdated : latest
          }, lastUpdatedAt)
          setLastUpdatedAt(mostRecent)

          // Trigger refetch of the steps query for this job
          await queryClient.invalidateQueries({ queryKey: ['job-steps', jobId] })
        }
        // If no updates found, keep lastUpdatedAt as is to avoid missing updates
      } catch (error) {
        // Silently handle errors - don't spam console
        // biome-ignore lint/suspicious/noConsole: Debug logging is acceptable here
        console.debug('Steps polling error:', error)
      }
    }

    // Set up polling interval
    intervalRef.current = setInterval(pollForUpdates, POLL_INTERVAL)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [enabled, jobId, lastUpdatedAt, queryClient, apiRequest])

  // Update lastUpdatedAt when steps data changes
  useEffect(() => {
    if (!enabled || !jobId) {
      return
    }

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event?.query?.queryKey[0] === 'job-steps' && event.query.queryKey[1] === jobId && event.type === 'updated') {
        const stepsData = event.query.state.data as GetJobStepsResponse | undefined
        if (stepsData?.steps && stepsData.steps.length > 0) {
          const mostRecent = stepsData.steps.reduce((latest: Date, step) => {
            const stepUpdated = new Date(step.updatedAt)
            return stepUpdated > latest ? stepUpdated : latest
          }, new Date(0))
          if (mostRecent.getTime() > 0) {
            setLastUpdatedAt((prev) => {
              // Only update if the new timestamp is more recent
              if (!prev || mostRecent > prev) {
                return mostRecent
              }
              return prev
            })
          }
        }
      }
    })

    return unsubscribe
  }, [enabled, jobId, queryClient])

  // Reset lastUpdatedAt when jobId changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: This is intentional
  useEffect(() => {
    setLastUpdatedAt(null)
  }, [jobId])
}
