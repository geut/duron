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
  page?: number
  pageSize?: number
}

interface UseJobMetricsOptions {
  jobId: string | null
  enabled?: boolean
  page?: number
  pageSize?: number
}

export function useJobMetrics({ jobId, enabled = true, page = 1, pageSize = 50 }: UseJobMetricsOptions) {
  const apiRequest = useApiRequest()

  return useQuery({
    queryKey: ['job-metrics', jobId, page, pageSize],
    queryFn: async () => {
      if (!jobId) {
        return { metrics: [], total: 0 }
      }
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      return apiRequest<MetricsResult>(`/jobs/${jobId}/metrics?${params}`)
    },
    enabled: enabled && !!jobId,
  })
}

interface UseStepMetricsOptions {
  stepId: string | null
  enabled?: boolean
  page?: number
  pageSize?: number
}

export function useStepMetrics({ stepId, enabled = true, page = 1, pageSize = 50 }: UseStepMetricsOptions) {
  const apiRequest = useApiRequest()

  return useQuery({
    queryKey: ['step-metrics', stepId, page, pageSize],
    queryFn: async () => {
      if (!stepId) {
        return { metrics: [], total: 0 }
      }
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      return apiRequest<MetricsResult>(`/steps/${stepId}/metrics?${params}`)
    },
    enabled: enabled && !!stepId,
  })
}

export type { Metric, MetricsResult }
