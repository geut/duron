import { createContext, type ReactNode, useContext, useState } from 'react'

interface AuthContextType {
  isAuthenticated: boolean
  token: string | null
  refreshToken: string | null
  login: (accessToken: string, refreshToken: string) => void
  logout: () => void
  updateAccessToken: (accessToken: string) => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

const ACCESS_TOKEN_KEY = 'auth_token'
const REFRESH_TOKEN_KEY = 'refresh_token'

function getInitialAuthState(): { token: string | null; refreshToken: string | null } {
  if (typeof window === 'undefined') {
    return { token: null, refreshToken: null }
  }
  const storedToken = localStorage.getItem(ACCESS_TOKEN_KEY)
  const storedRefreshToken = localStorage.getItem(REFRESH_TOKEN_KEY)
  if (storedToken && storedRefreshToken) {
    return { token: storedToken, refreshToken: storedRefreshToken }
  }
  return { token: null, refreshToken: null }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Load auth state synchronously to avoid flash of login page
  const [authState, setAuthState] = useState(() => getInitialAuthState())
  const { token, refreshToken } = authState

  const login = (newToken: string, newRefreshToken: string) => {
    localStorage.setItem(ACCESS_TOKEN_KEY, newToken)
    localStorage.setItem(REFRESH_TOKEN_KEY, newRefreshToken)
    setAuthState({ token: newToken, refreshToken: newRefreshToken })
  }

  const updateAccessToken = (newToken: string) => {
    localStorage.setItem(ACCESS_TOKEN_KEY, newToken)
    setAuthState((prev) => ({ ...prev, token: newToken }))
  }

  const logout = () => {
    localStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
    setAuthState({ token: null, refreshToken: null })
  }

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!token && !!refreshToken,
        token,
        refreshToken,
        login,
        logout,
        updateAccessToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
