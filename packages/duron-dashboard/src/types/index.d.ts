import type React from 'react'

/**
 * Theme values that can be applied to the dashboard.
 */
export type Theme = 'light' | 'dark'

/**
 * Theme options for configuring the dashboard theme.
 * - 'light': Always use light theme
 * - 'dark': Always use dark theme
 * - 'system': Use the system preference (default)
 */
export type ThemeOption = Theme | 'system'

/**
 * Props for the DuronDashboard component.
 */
export interface DuronDashboardProps {
  /**
   * The base URL for the Duron API.
   */
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
   * Custom fetch function to use for API requests.
   * This allows you to intercept, modify, or wrap fetch calls.
   * Defaults to the native fetch.
   */
  customFetch?: CustomFetch
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
}

/**
 * Duron Dashboard React component.
 *
 * @example
 * ```tsx
 * import { DuronDashboard } from 'duron-dashboard'
 *
 * function App() {
 *   return <DuronDashboard url="http://localhost:3000/api" />
 * }
 * ```
 */
export declare const DuronDashboard: React.FC<DuronDashboardProps>
