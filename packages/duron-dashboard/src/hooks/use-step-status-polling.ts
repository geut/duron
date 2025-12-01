import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { useApiRequest } from '@/lib/api'

const POLL_INTERVAL = 2000 // 2 seconds

interface StepStatusResult {
  status: string
  updatedAt: string
}

/**
 * Hook to poll for step status updates every 2 seconds.
 * If the updatedAt timestamp changes, it triggers a refetch of the steps list for the job.
 */
export function useStepStatusPolling(stepId: string | null, jobId: string | null, enabled: boolean = true) {
  const queryClient = useQueryClient()
  const apiRequest = useApiRequest()
  const previousUpdatedAtRef = useRef<string | null>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (!enabled || !stepId || !jobId) {
      return
    }

    // Poll for status updates
    const pollForStatus = async () => {
      if (!stepId || !jobId) {
        return
      }

      try {
        const statusResult = await apiRequest<StepStatusResult>(`/steps/${stepId}/status`)

        // Compare current updatedAt with previous updatedAt
        if (statusResult.updatedAt !== previousUpdatedAtRef.current) {
          // UpdatedAt changed - trigger refetch of the steps list and individual step
          await queryClient.invalidateQueries({ queryKey: ['job-steps', jobId] })
          await queryClient.invalidateQueries({ queryKey: ['step', stepId] })
        }

        // Update the previous updatedAt
        previousUpdatedAtRef.current = statusResult.updatedAt
      } catch (error) {
        // Silently handle errors - don't spam console
        // biome-ignore lint/suspicious/noConsole: Debug logging is acceptable here
        console.debug('Step status polling error:', error)
      }
    }

    // Set up polling interval
    intervalRef.current = setInterval(pollForStatus, POLL_INTERVAL)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [enabled, stepId, jobId, queryClient, apiRequest])

  // Reset previous updatedAt when stepId or jobId changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: This is intentional
  useEffect(() => {
    previousUpdatedAtRef.current = null
  }, [stepId, jobId])
}
