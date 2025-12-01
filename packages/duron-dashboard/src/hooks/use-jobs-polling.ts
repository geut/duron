import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import type { GetJobsResponse } from '@/lib/api'
import { useApiRequest } from '@/lib/api'

const POLL_INTERVAL = 2000 // 2 seconds

/**
 * Hook to poll for job updates and trigger refetch when updates are detected.
 * Stores the last updated_at timestamp and polls for jobs updated after that time.
 */
export function useJobsPolling(enabled: boolean = true) {
  const queryClient = useQueryClient()
  const apiRequest = useApiRequest()
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }

    // Initialize lastUpdatedAt from the current jobs data if available
    const initializeLastUpdated = () => {
      const jobsData = queryClient.getQueryData<GetJobsResponse>(['jobs'])
      if (jobsData?.jobs && jobsData.jobs.length > 0) {
        // Find the most recent updated_at
        const mostRecent = jobsData.jobs.reduce((latest: Date, job) => {
          const jobUpdated = new Date(job.updatedAt)
          return jobUpdated > latest ? jobUpdated : latest
        }, new Date(0))
        if (mostRecent.getTime() > 0) {
          setLastUpdatedAt(mostRecent)
        }
      } else if (lastUpdatedAt === null) {
        // If no jobs data and no lastUpdatedAt, set to now minus a small buffer
        setLastUpdatedAt(new Date(Date.now() - 1000))
      }
    }

    // Initialize on mount
    initializeLastUpdated()

    // Poll for updates
    const pollForUpdates = async () => {
      if (!lastUpdatedAt) {
        return
      }

      try {
        const queryParams = new URLSearchParams()
        queryParams.set('fUpdatedAfter', lastUpdatedAt.toISOString())
        queryParams.set('pageSize', '1') // We only need to know if there are updates

        const data = await apiRequest<GetJobsResponse>(`/jobs?${queryParams.toString()}`)

        if (data.jobs.length > 0) {
          // Updates found - update the timestamp and trigger refetch
          const mostRecent = data.jobs.reduce((latest: Date, job) => {
            const jobUpdated = new Date(job.updatedAt)
            return jobUpdated > latest ? jobUpdated : latest
          }, lastUpdatedAt)
          setLastUpdatedAt(mostRecent)

          // Trigger refetch of the main jobs query
          await queryClient.invalidateQueries({ queryKey: ['jobs'] })
        }
        // If no updates found, keep lastUpdatedAt as is to avoid missing updates
      } catch (error) {
        // Silently handle errors - don't spam console
        // biome-ignore lint/suspicious/noConsole: Debug logging is acceptable here
        console.debug('Polling error:', error)
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
  }, [enabled, lastUpdatedAt, queryClient, apiRequest])

  // Update lastUpdatedAt when jobs data changes
  useEffect(() => {
    if (!enabled) {
      return
    }

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event?.query?.queryKey[0] === 'jobs' && event.type === 'updated') {
        const jobsData = event.query.state.data as GetJobsResponse | undefined
        if (jobsData?.jobs && jobsData.jobs.length > 0) {
          const mostRecent = jobsData.jobs.reduce((latest: Date, job) => {
            const jobUpdated = new Date(job.updatedAt)
            return jobUpdated > latest ? jobUpdated : latest
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
  }, [enabled, queryClient])
}
