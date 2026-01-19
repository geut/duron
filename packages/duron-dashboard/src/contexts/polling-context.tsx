import { createContext, type ReactNode, useContext } from 'react'

interface PollingContextType {
  pollingInterval: number
}

const DEFAULT_POLLING_INTERVAL = 2000 // 2 seconds

const PollingContext = createContext<PollingContextType>({ pollingInterval: DEFAULT_POLLING_INTERVAL })

export interface PollingProviderProps {
  children: ReactNode
  /**
   * Polling interval in milliseconds for real-time updates.
   * Defaults to 2000ms (2 seconds).
   */
  pollingInterval?: number
}

export function PollingProvider({ children, pollingInterval = DEFAULT_POLLING_INTERVAL }: PollingProviderProps) {
  return <PollingContext.Provider value={{ pollingInterval }}>{children}</PollingContext.Provider>
}

export function usePollingInterval() {
  const { pollingInterval } = useContext(PollingContext)
  return pollingInterval
}
