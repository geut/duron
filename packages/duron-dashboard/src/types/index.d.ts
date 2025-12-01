import type React from 'react'

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
