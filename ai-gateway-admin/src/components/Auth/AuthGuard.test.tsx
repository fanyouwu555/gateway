import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './AuthContext'
import AuthGuard from './AuthGuard'

beforeEach(() => sessionStorage.clear())

function TestPage() {
  return <div data-testid="protected-page">Protected Content</div>
}

function LoginPage() {
  return <div data-testid="login-page">Login Page</div>
}

describe('AuthGuard', () => {
  it('renders children when authenticated', () => {
    sessionStorage.setItem('api_token', 'valid-key')
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dashboard" element={<AuthGuard><TestPage /></AuthGuard>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    )
    expect(screen.getByTestId('protected-page')).toBeInTheDocument()
  })

  it('redirects to /login when unauthenticated', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dashboard" element={<AuthGuard><TestPage /></AuthGuard>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    )
    expect(screen.getByTestId('login-page')).toBeInTheDocument()
    expect(screen.queryByTestId('protected-page')).not.toBeInTheDocument()
  })
})
