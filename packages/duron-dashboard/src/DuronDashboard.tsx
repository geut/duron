import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NuqsAdapter } from 'nuqs/adapters/react'

import { ApiProvider, type CustomFetch } from './contexts/api-context'
import { AuthProvider, useAuth } from './contexts/auth-context'
import { LayoutProvider } from './contexts/layout-context'
import { MetricsProvider } from './contexts/metrics-context'
import { PollingProvider } from './contexts/polling-context'
import { ThemeProvider, type ThemeOption } from './contexts/theme-context'
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
  showThemeToggle?: boolean
  className?: string
}

function AppContent({ enableLogin = true, showLogo = true, showThemeToggle = true, className }: AppContentProps) {
  const { isAuthenticated } = useAuth()

  if (enableLogin && !isAuthenticated) {
    return <Login />
  }

  return (
    <NuqsAdapter>
      <Dashboard
        showLogo={showLogo}
        enableLogin={enableLogin}
        showThemeToggle={showThemeToggle}
        className={className}
      />
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
  /**
   * Controls whether the theme toggle button is shown in the navbar.
   * Defaults to true.
   */
  showThemeToggle?: boolean
  /**
   * The theme to use for the dashboard.
   * - 'light': Always use light theme
   * - 'dark': Always use dark theme
   * - 'system': Use the system preference (default)
   */
  theme?: ThemeOption
  /**
   * Custom fetch function to use for API requests.
   * This allows you to intercept, modify, or wrap fetch calls.
   * Defaults to the native fetch.
   */
  customFetch?: CustomFetch
  /**
   * Custom className to apply to the root dashboard container.
   * Merged with the default classes using clsx.
   */
  className?: string
  /**
   * Polling interval in milliseconds for real-time updates.
   * Defaults to 2000ms (2 seconds).
   */
  pollingInterval?: number
}

export function DuronDashboard({
  url,
  enableLogin = false,
  showLogo = true,
  showThemeToggle = true,
  theme = 'system',
  customFetch,
  className,
  pollingInterval,
}: DuronDashboardProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme={theme}>
        <LayoutProvider>
          <PollingProvider pollingInterval={pollingInterval}>
            <ApiProvider baseUrl={url} customFetch={customFetch}>
              <AuthProvider>
                <MetricsProvider>
                  <AppContent
                    enableLogin={enableLogin}
                    showLogo={showLogo}
                    showThemeToggle={showThemeToggle}
                    className={className}
                  />
                </MetricsProvider>
              </AuthProvider>
            </ApiProvider>
          </PollingProvider>
        </LayoutProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
