import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { useAuth, AuthProvider } from './AuthContext'

beforeEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function TestComponent() {
  const { isAuthenticated, apiKey, login, logout } = useAuth()
  return (
    <div>
      <div data-testid="auth">{isAuthenticated ? 'authenticated' : 'unauthenticated'}</div>
      <div data-testid="key">{apiKey || 'none'}</div>
      <button data-testid="login-btn" onClick={() => login('test-key')}>Login</button>
      <button data-testid="logout-btn" onClick={logout}>Logout</button>
    </div>
  )
}

describe('AuthContext', () => {
  it('defaults to unauthenticated', () => {
    render(<AuthProvider><TestComponent /></AuthProvider>)
    expect(screen.getByTestId('auth').textContent).toBe('unauthenticated')
    expect(screen.getByTestId('key').textContent).toBe('none')
  })

  it('reads api_token from sessionStorage on mount', () => {
    sessionStorage.setItem('api_token', 'stored-key')
    render(<AuthProvider><TestComponent /></AuthProvider>)
    expect(screen.getByTestId('auth').textContent).toBe('authenticated')
    expect(screen.getByTestId('key').textContent).toBe('stored-key')
  })

  it('login() stores key and sets authenticated', async () => {
    render(<AuthProvider><TestComponent /></AuthProvider>)
    fireEvent.click(screen.getByTestId('login-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('authenticated')
    })
    expect(screen.getByTestId('key').textContent).toBe('test-key')
    expect(sessionStorage.getItem('api_token')).toBe('test-key')
  })

  it('logout() clears key and sets unauthenticated', async () => {
    sessionStorage.setItem('api_token', 'stored-key')
    render(<AuthProvider><TestComponent /></AuthProvider>)
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('authenticated')
    })
    fireEvent.click(screen.getByTestId('logout-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('unauthenticated')
    })
    expect(screen.getByTestId('key').textContent).toBe('none')
    expect(sessionStorage.getItem('api_token')).toBeNull()
  })

  it('login() overwrites existing key', async () => {
    sessionStorage.setItem('api_token', 'old-key')
    render(<AuthProvider><TestComponent /></AuthProvider>)
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('authenticated')
    })
    fireEvent.click(screen.getByTestId('login-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('key').textContent).toBe('test-key')
    })
    expect(sessionStorage.getItem('api_token')).toBe('test-key')
  })

  it('throws when useAuth is called outside AuthProvider', () => {
    expect(() => render(<TestComponent />)).toThrow('useAuth must be used within AuthProvider')
  })
})
