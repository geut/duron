'use client'

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

type StepViewType = 'list' | 'timeline'

interface StepViewContextValue {
  viewType: StepViewType
  setViewType: (type: StepViewType) => void
}

const STORAGE_KEY = 'duron-step-view-type'

const StepViewContext = createContext<StepViewContextValue | null>(null)

export function StepViewProvider({ children }: { children: ReactNode }) {
  const [viewType, setViewTypeState] = useState<StepViewType>('list')

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'list' || stored === 'timeline') {
      setViewTypeState(stored)
    }
  }, [])

  const setViewType = useCallback((type: StepViewType) => {
    setViewTypeState(type)
    localStorage.setItem(STORAGE_KEY, type)
  }, [])

  return <StepViewContext.Provider value={{ viewType, setViewType }}>{children}</StepViewContext.Provider>
}

export function useStepView() {
  const context = useContext(StepViewContext)
  if (!context) {
    throw new Error('useStepView must be used within a StepViewProvider')
  }
  return context
}
