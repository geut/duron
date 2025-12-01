'use client'

import { useState } from 'react'

import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/auth-context'
import { useLogin } from '@/lib/api'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const loginMutation = useLogin()
  const { login } = useAuth()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const result = await loginMutation.mutateAsync({ email, password })
      login(result.accessToken, result.refreshToken)
    } catch {
      // Error is already handled by React Query's error state
      // The error will be displayed via loginMutation.isError
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="flex flex-1 flex-col justify-center px-4 py-10 lg:px-6">
        <div className="sm:mx-auto sm:w-full sm:max-w-sm">
          <div className="flex justify-center mb-6">
            <Logo className="h-32" />
          </div>
          <h3 className="text-center text-lg font-semibold text-foreground dark:text-foreground">Welcome Back</h3>
          <p className="text-center text-sm text-muted-foreground dark:text-muted-foreground">
            Enter your credentials to access your account.
          </p>
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <Label htmlFor="email-login-03" className="text-sm font-medium text-foreground dark:text-foreground">
                Email
              </Label>
              <Input
                type="email"
                id="email-login-03"
                name="email-login-03"
                autoComplete="email"
                placeholder="user@example.com"
                className="mt-2"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required={true}
              />
            </div>
            <div>
              <Label htmlFor="password-login-03" className="text-sm font-medium text-foreground dark:text-foreground">
                Password
              </Label>
              <Input
                type="password"
                id="password-login-03"
                name="password-login-03"
                autoComplete="password"
                placeholder="**************"
                className="mt-2"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required={true}
              />
            </div>
            {loginMutation.isError && (
              <div className="text-sm text-destructive">
                {loginMutation.error instanceof Error ? loginMutation.error.message : 'Login failed'}
              </div>
            )}
            <Button type="submit" className="mt-4 w-full py-2 font-medium" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
