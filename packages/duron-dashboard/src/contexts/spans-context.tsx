import { useQuery } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext } from 'react'

import { useApi, useFetch } from './api-context'
import { useAuth } from './auth-context'

interface SpansContextType {
  spansEnabled: boolean
  isLoading: boolean
}

const SpansContext = createContext<SpansContextType | undefined>(undefined)

export function SpansProvider({ children }: { children: ReactNode }) {
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
      return response.json() as Promise<{ spansEnabled: boolean; authEnabled: boolean }>
    },
    staleTime: Number.POSITIVE_INFINITY, // Config rarely changes
  })

  return (
    <SpansContext.Provider value={{ spansEnabled: data?.spansEnabled ?? false, isLoading }}>
      {children}
    </SpansContext.Provider>
  )
}

export function useSpans() {
  const context = useContext(SpansContext)
  if (context === undefined) {
    throw new Error('useSpans must be used within a SpansProvider')
  }
  return context
}
