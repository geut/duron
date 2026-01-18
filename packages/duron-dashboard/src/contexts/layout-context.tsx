'use client'

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'

type StepViewType = 'list' | 'timeline'

interface DesktopLayout {
  /** Horizontal panel sizes: [details, steps] as percentages (bottom row) */
  horizontalSizes: number[]
  /** Vertical panel sizes: [jobs, bottom] as percentages */
  verticalSizes: number[]
}

interface MobileLayout {
  /** Vertical panel sizes: [jobs, details, steps] as percentages */
  verticalSizes: number[]
}

interface LayoutConfig {
  /** Step view type: 'list' or 'timeline' */
  stepViewType: StepViewType
  /** Desktop layout configuration */
  desktop: DesktopLayout
  /** Mobile layout configuration */
  mobile: MobileLayout
}

interface LayoutContextValue {
  config: LayoutConfig
  setStepViewType: (type: StepViewType) => void
  setDesktopHorizontalSizes: (sizes: number[]) => void
  setDesktopVerticalSizes: (sizes: number[]) => void
  setMobileVerticalSizes: (sizes: number[]) => void
}

const STORAGE_KEY = 'duron-layout-config'

const DEFAULT_CONFIG: LayoutConfig = {
  stepViewType: 'list',
  desktop: {
    horizontalSizes: [30, 70], // [details, steps] - details takes 30% by default
    verticalSizes: [50, 50], // [jobs, bottom]
  },
  mobile: {
    verticalSizes: [33, 33, 34],
  },
}

const LayoutContext = createContext<LayoutContextValue | null>(null)

function loadConfig(): LayoutConfig {
  if (typeof window === 'undefined') {
    return DEFAULT_CONFIG
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)

      // Handle migration from old format (horizontalSizes/verticalSizes at root)
      const desktop: DesktopLayout = parsed.desktop ?? {
        horizontalSizes: parsed.horizontalSizes ?? DEFAULT_CONFIG.desktop.horizontalSizes,
        verticalSizes: parsed.verticalSizes ?? DEFAULT_CONFIG.desktop.verticalSizes,
      }

      const mobile: MobileLayout = parsed.mobile ?? {
        verticalSizes: DEFAULT_CONFIG.mobile.verticalSizes,
      }

      return {
        stepViewType: parsed.stepViewType === 'timeline' ? 'timeline' : 'list',
        desktop: {
          horizontalSizes: Array.isArray(desktop.horizontalSizes)
            ? desktop.horizontalSizes
            : DEFAULT_CONFIG.desktop.horizontalSizes,
          verticalSizes: Array.isArray(desktop.verticalSizes)
            ? desktop.verticalSizes
            : DEFAULT_CONFIG.desktop.verticalSizes,
        },
        mobile: {
          verticalSizes: Array.isArray(mobile.verticalSizes)
            ? mobile.verticalSizes
            : DEFAULT_CONFIG.mobile.verticalSizes,
        },
      }
    }
  } catch {
    // Ignore parsing errors
  }

  return DEFAULT_CONFIG
}

function saveConfig(config: LayoutConfig): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // Ignore storage errors
  }
}

export function LayoutProvider({ children }: { children: ReactNode }) {
  // Load config synchronously on first render to avoid flash of default layout
  const [config, setConfig] = useState<LayoutConfig>(() => loadConfig())

  const setStepViewType = useCallback((type: StepViewType) => {
    setConfig((prev) => {
      const next = { ...prev, stepViewType: type }
      saveConfig(next)
      return next
    })
  }, [])

  const setDesktopHorizontalSizes = useCallback((sizes: number[]) => {
    setConfig((prev) => {
      const next = { ...prev, desktop: { ...prev.desktop, horizontalSizes: sizes } }
      saveConfig(next)
      return next
    })
  }, [])

  const setDesktopVerticalSizes = useCallback((sizes: number[]) => {
    setConfig((prev) => {
      const next = { ...prev, desktop: { ...prev.desktop, verticalSizes: sizes } }
      saveConfig(next)
      return next
    })
  }, [])

  const setMobileVerticalSizes = useCallback((sizes: number[]) => {
    setConfig((prev) => {
      const next = { ...prev, mobile: { ...prev.mobile, verticalSizes: sizes } }
      saveConfig(next)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({
      config,
      setStepViewType,
      setDesktopHorizontalSizes,
      setDesktopVerticalSizes,
      setMobileVerticalSizes,
    }),
    [config, setStepViewType, setDesktopHorizontalSizes, setDesktopVerticalSizes, setMobileVerticalSizes],
  )

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>
}

export function useLayout() {
  const context = useContext(LayoutContext)
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider')
  }
  return context
}

// Convenience hook for step view type (backwards compatible)
export function useStepView() {
  const { config, setStepViewType } = useLayout()
  return {
    viewType: config.stepViewType,
    setViewType: setStepViewType,
  }
}
