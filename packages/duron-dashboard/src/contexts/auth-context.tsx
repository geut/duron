import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState<string | null>(null)

  useEffect(() => {
    const storedToken = localStorage.getItem(ACCESS_TOKEN_KEY)
    const storedRefreshToken = localStorage.getItem(REFRESH_TOKEN_KEY)
    if (storedToken && storedRefreshToken) {
      setToken(storedToken)
      setRefreshToken(storedRefreshToken)
    }
  }, [])

  const login = (newToken: string, newRefreshToken: string) => {
    localStorage.setItem(ACCESS_TOKEN_KEY, newToken)
    localStorage.setItem(REFRESH_TOKEN_KEY, newRefreshToken)
    setToken(newToken)
    setRefreshToken(newRefreshToken)
  }

  const updateAccessToken = (newToken: string) => {
    localStorage.setItem(ACCESS_TOKEN_KEY, newToken)
    setToken(newToken)
  }

  const logout = () => {
    localStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
    setToken(null)
    setRefreshToken(null)
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
