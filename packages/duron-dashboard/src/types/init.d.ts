import type { DuronDashboardProps } from './index'

/**
 * Options for initializing the Duron dashboard.
 * Extends DuronDashboardProps with all the same configuration options.
 */
export interface InitDuronOptions extends DuronDashboardProps {}

/**
 * Initialize the Duron dashboard in a DOM element.
 * This function handles all React setup internally.
 *
 * @param element - The DOM element (or selector string) where the dashboard should be mounted
 * @param options - Configuration options for the dashboard
 * @returns A cleanup function that unmounts the dashboard
 *
 * @example
 * ```ts
 * import { initDuron } from 'duron-dashboard/init'
 *
 * const cleanup = initDuron('#dashboard-container', {
 *   url: 'http://localhost:3000/api',
 *   enableLogin: true,
 *   showLogo: true
 * })
 *
 * // Later, to unmount:
 * cleanup()
 * ```
 */
export declare function initDuron(element: HTMLElement | string, options: InitDuronOptions): () => void
