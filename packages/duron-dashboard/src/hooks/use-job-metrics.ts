import { useQuery } from '@tanstack/react-query'

import { useApiRequest } from '@/lib/api'

interface Metric {
  id: string
  jobId: string
  stepId: string | null
  name: string
  value: number
  attributes: Record<string, any>
  type: 'gauge' | 'counter' | 'histogram' | 'summary'
  timestamp: string
}

interface MetricsResult {
  metrics: Metric[]
  total: number
}

interface UseJobMetricsOptions {
  jobId: string | null
  enabled?: boolean
}

export function useJobMetrics({ jobId, enabled = true }: UseJobMetricsOptions) {
  const apiRequest = useApiRequest()

  return useQuery({
    queryKey: ['job-metrics', jobId],
    queryFn: async () => {
      if (!jobId) {
        return { metrics: [], total: 0 }
      }
      return apiRequest<MetricsResult>(`/jobs/${jobId}/metrics`)
    },
    enabled: enabled && !!jobId,
  })
}

interface UseStepMetricsOptions {
  stepId: string | null
  enabled?: boolean
}

export function useStepMetrics({ stepId, enabled = true }: UseStepMetricsOptions) {
  const apiRequest = useApiRequest()

  return useQuery({
    queryKey: ['step-metrics', stepId],
    queryFn: async () => {
      if (!stepId) {
        return { metrics: [], total: 0 }
      }
      return apiRequest<MetricsResult>(`/steps/${stepId}/metrics`)
    },
    enabled: enabled && !!stepId,
  })
}

export type { Metric, MetricsResult }
