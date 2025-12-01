import { createContext, type ReactNode, useContext } from 'react'

interface ApiContextType {
  baseUrl: string
}

const ApiContext = createContext<ApiContextType | undefined>(undefined)

export function ApiProvider({ children, baseUrl }: { children: ReactNode; baseUrl: string }) {
  return <ApiContext.Provider value={{ baseUrl }}>{children}</ApiContext.Provider>
}

export function useApi() {
  const context = useContext(ApiContext)
  if (context === undefined) {
    throw new Error('useApi must be used within an ApiProvider')
  }
  return context
}
