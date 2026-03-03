'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export type Theme = 'light' | 'dark'
export type ThemeOption = Theme | 'system'

interface ThemeContextType {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const STORAGE_KEY = 'duron-theme'

function getSystemTheme(): Theme {
  if (typeof window !== 'undefined') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

function resolveTheme(option: ThemeOption): Theme {
  if (option === 'system') {
    return getSystemTheme()
  }
  return option
}

function applyTheme(theme: Theme) {
  if (typeof window !== 'undefined') {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }
}

function getStoredTheme(): Theme | null {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
    if (stored === 'light' || stored === 'dark') {
      return stored
    }
  }
  return null
}

export interface ThemeProviderProps {
  children: React.ReactNode
  /**
   * The theme to use.
   * - 'light': Always use light theme
   * - 'dark': Always use dark theme
   * - 'system': Use the system preference (default)
   *
   * This prop is reactive - changing it will update the theme dynamically.
   * User's explicit choice (via toggle button) takes precedence and is stored in localStorage.
   */
  defaultTheme?: ThemeOption
}

export function ThemeProvider({ children, defaultTheme = 'system' }: ThemeProviderProps) {
  // Track if user has made an explicit choice via the toggle button
  // Initialize based on whether there's already a stored preference
  const userChoiceRef = useRef<boolean>(getStoredTheme() !== null)

  const [theme, setThemeState] = useState<Theme>(() => {
    // Check localStorage first - user's explicit choice takes precedence
    const stored = getStoredTheme()
    if (stored) {
      applyTheme(stored)
      return stored
    }

    // Fall back to the defaultTheme prop
    const resolvedTheme = resolveTheme(defaultTheme)
    applyTheme(resolvedTheme)
    return resolvedTheme
  })

  // Sync theme when defaultTheme prop changes, but only if user hasn't made an explicit choice
  useEffect(() => {
    if (!userChoiceRef.current) {
      const resolvedTheme = resolveTheme(defaultTheme)
      setThemeState(resolvedTheme)
      applyTheme(resolvedTheme)
    }
  }, [defaultTheme])

  // Apply theme to DOM when it changes
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Set theme explicitly (saves to localStorage)
  const setTheme = useCallback((newTheme: Theme) => {
    userChoiceRef.current = true
    localStorage.setItem(STORAGE_KEY, newTheme)
    setThemeState(newTheme)
  }, [])

  // Toggle theme (saves to localStorage)
  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const newTheme = prev === 'dark' ? 'light' : 'dark'
      userChoiceRef.current = true
      localStorage.setItem(STORAGE_KEY, newTheme)
      return newTheme
    })
  }, [])

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
