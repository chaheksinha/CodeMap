import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { UNAUTHORIZED_EVENT, api, getToken, setToken } from './api'

type AuthValue = {
  email: string | null
  ready: boolean
  signIn: (email: string, password: string, mode: 'login' | 'register') => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const token = getToken()
    if (!token) {
      setReady(true)
      return
    }
    api<{ email: string }>('/auth/me')
      .then((me) => setEmail(me.email))
      .catch(() => setToken(null))
      .finally(() => setReady(true))
  }, [])

  useEffect(() => {
    const onExpired = () => setEmail(null)
    window.addEventListener(UNAUTHORIZED_EVENT, onExpired)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onExpired)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      email,
      ready,
      async signIn(nextEmail, password, mode) {
        const path = mode === 'register' ? '/auth/register' : '/auth/login'
        const result = await api<{ token: string; email: string }>(path, {
          method: 'POST',
          json: { email: nextEmail, password },
        })
        setToken(result.token)
        setEmail(result.email)
      },
      logout() {
        setToken(null)
        setEmail(null)
      },
    }),
    [email, ready],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('AuthProvider missing')
  return value
}
