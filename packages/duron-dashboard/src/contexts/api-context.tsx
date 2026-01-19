import { createContext, type ReactNode, useContext, useMemo } from 'react'

export type CustomFetch = typeof fetch

interface ApiContextType {
  baseUrl: string
  customFetch: CustomFetch
}

const ApiContext = createContext<ApiContextType | undefined>(undefined)

export interface ApiProviderProps {
  children: ReactNode
  baseUrl: string
  /**
   * Custom fetch function to use for API requests.
   * Defaults to the native fetch.
   */
  customFetch?: CustomFetch
}

export function ApiProvider({ children, baseUrl, customFetch }: ApiProviderProps) {
  const value = useMemo(
    () => ({
      baseUrl,
      customFetch: customFetch ?? fetch,
    }),
    [baseUrl, customFetch],
  )
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
}

export function useApi() {
  const context = useContext(ApiContext)
  if (context === undefined) {
    throw new Error('useApi must be used within an ApiProvider')
  }
  return context
}

export function useFetch() {
  const { customFetch } = useApi()
  return customFetch
}
