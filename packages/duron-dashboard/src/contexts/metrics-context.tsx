import { useQuery } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext } from 'react'

import { useApi, useFetch } from './api-context'
import { useAuth } from './auth-context'

interface MetricsContextType {
  metricsEnabled: boolean
  isLoading: boolean
}

const MetricsContext = createContext<MetricsContextType | undefined>(undefined)

export function MetricsProvider({ children }: { children: ReactNode }) {
  const { baseUrl } = useApi()
  const { token } = useAuth()
  const fetchFn = useFetch()

  const { data, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: async () => {
      const headers: HeadersInit = {}
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }
      const response = await fetchFn(`${baseUrl}/config`, { headers })
      if (!response.ok) {
        throw new Error('Failed to fetch config')
      }
      return response.json() as Promise<{ metricsEnabled: boolean; authEnabled: boolean }>
    },
    staleTime: Number.POSITIVE_INFINITY, // Config rarely changes
  })

  return (
    <MetricsContext.Provider value={{ metricsEnabled: data?.metricsEnabled ?? false, isLoading }}>
      {children}
    </MetricsContext.Provider>
  )
}

export function useMetrics() {
  const context = useContext(MetricsContext)
  if (context === undefined) {
    throw new Error('useMetrics must be used within a MetricsProvider')
  }
  return context
}
