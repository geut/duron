import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NuqsAdapter } from 'nuqs/adapters/react'

import { ApiProvider } from './contexts/api-context'
import { AuthProvider, useAuth } from './contexts/auth-context'
import { ThemeProvider } from './contexts/theme-context'
import { Dashboard } from './views/dashboard'
import Login from './views/login'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

interface AppContentProps {
  enableLogin?: boolean
  showLogo?: boolean
}

function AppContent({ enableLogin = true, showLogo = true }: AppContentProps) {
  const { isAuthenticated } = useAuth()

  if (enableLogin && !isAuthenticated) {
    return <Login />
  }

  return (
    <NuqsAdapter>
      <Dashboard showLogo={showLogo} enableLogin={enableLogin} />
    </NuqsAdapter>
  )
}

export interface DuronDashboardProps {
  url: string
  /**
   * Enable authentication flow (login/logout) in the dashboard.
   * When disabled, the dashboard is always considered authenticated and no login screen is shown.
   * Defaults to true.
   */
  enableLogin?: boolean
  /**
   * Controls whether the Duron logo is shown in the navbar.
   * Defaults to true.
   */
  showLogo?: boolean
}

export function DuronDashboard({ url, enableLogin = false, showLogo = true }: DuronDashboardProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ApiProvider baseUrl={url}>
          <AuthProvider>
            <AppContent enableLogin={enableLogin} showLogo={showLogo} />
          </AuthProvider>
        </ApiProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
