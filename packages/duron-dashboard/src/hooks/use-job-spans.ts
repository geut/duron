import { useQuery } from '@tanstack/react-query'

import { useApiRequest } from '@/lib/api'

interface SpanEvent {
  name: string
  timeUnixNano: string
  attributes?: Record<string, any>
}

interface Span {
  id: number
  traceId: string
  spanId: string
  parentSpanId: string | null
  jobId: string | null
  stepId: string | null
  name: string
  kind: number
  startTimeUnixNano: string | null
  endTimeUnixNano: string | null
  statusCode: number
  statusMessage: string | null
  attributes: Record<string, any>
  events: SpanEvent[]
}

interface SpansResult {
  spans: Span[]
  total: number
}

interface UseJobSpansOptions {
  jobId: string | null
  enabled?: boolean
}

export function useJobSpans({ jobId, enabled = true }: UseJobSpansOptions) {
  const apiRequest = useApiRequest()

  return useQuery({
    queryKey: ['job-spans', jobId],
    queryFn: async () => {
      if (!jobId) {
        return { spans: [], total: 0 }
      }
      return apiRequest<SpansResult>(`/jobs/${jobId}/spans`)
    },
    enabled: enabled && !!jobId,
  })
}

interface UseStepSpansOptions {
  stepId: string | null
  enabled?: boolean
}

export function useStepSpans({ stepId, enabled = true }: UseStepSpansOptions) {
  const apiRequest = useApiRequest()

  return useQuery({
    queryKey: ['step-spans', stepId],
    queryFn: async () => {
      if (!stepId) {
        return { spans: [], total: 0 }
      }
      return apiRequest<SpansResult>(`/steps/${stepId}/spans`)
    },
    enabled: enabled && !!stepId,
  })
}

export type { Span, SpanEvent, SpansResult }
