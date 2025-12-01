import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { DuronDashboardProps } from './DuronDashboard'
import { DuronDashboard } from './DuronDashboard'
import './index.css'

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
export function initDuron(element: HTMLElement | string, options: InitDuronOptions): () => void {
  // Resolve element if string selector is provided
  let container: HTMLElement
  if (typeof element === 'string') {
    const found = document.querySelector<HTMLElement>(element)
    if (!found) {
      throw new Error(`Element not found: ${element}`)
    }
    container = found
  } else {
    container = element
  }

  // Clear any existing content
  container.innerHTML = ''

  const app = (
    <StrictMode>
      <DuronDashboard {...options} />
    </StrictMode>
  )

  let root: Root | undefined
  if (import.meta.hot) {
    // With hot module reloading, `import.meta.hot.data` is persisted.
    // biome-ignore lint/suspicious/noAssignInExpressions: all good here
    const root = (import.meta.hot.data.root ??= createRoot(container))
    root.render(app)
  } else {
    // The hot module reloading API is not available in production.
    root = createRoot(container)
    root.render(app)
  }

  // Return cleanup function
  return () => {
    root?.unmount()
    container.innerHTML = ''
  }
}

;(globalThis as any).initDuron = initDuron
