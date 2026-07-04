import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface AuthContextValue {
  apiKey: string | null
  isAuthenticated: boolean
  login: (key: string) => void
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(() => {
    return sessionStorage.getItem('api_token')
  })

  const login = useCallback((key: string) => {
    sessionStorage.setItem('api_token', key)
    setApiKey(key)
  }, [])

  const logout = useCallback(() => {
    sessionStorage.removeItem('api_token')
    setApiKey(null)
  }, [])

  return (
    <AuthContext.Provider value={{ apiKey, isAuthenticated: !!apiKey, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
