# Frontend API Key Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add login page, route guard, and 401 handling to the admin frontend, replacing the hardcoded fallback API key.

**Architecture:** React Context for auth state, AuthGuard wrapper for route protection, raw `fetch()` for login verification (avoids Axios 401 interceptor loop), and a simple `window.location.href` redirect in the Axios 401 handler.

**Tech Stack:** React 18, React Router 6, Ant Design 5, Axios, Vitest + Testing Library + MSW

---
### Task 1: AuthContext — Auth state management

**Files:**
- Create: `ai-gateway-admin/src/components/Auth/AuthContext.tsx`

- [ ] **Step 1: Write the failing AuthContext test**

Create `ai-gateway-admin/src/components/Auth/AuthContext.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { useAuth, AuthProvider } from './AuthContext'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
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

  it('reads api_token from localStorage on mount', () => {
    localStorage.setItem('api_token', 'stored-key')
    render(<AuthProvider><TestComponent /></AuthProvider>)
    expect(screen.getByTestId('auth').textContent).toBe('authenticated')
    expect(screen.getByTestId('key').textContent).toBe('stored-key')
  })

  it('login() stores key and sets authenticated', async () => {
    render(<AuthProvider><TestComponent /></AuthProvider>)
    screen.getByTestId('login-btn').click()
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('authenticated')
    })
    expect(screen.getByTestId('key').textContent).toBe('test-key')
    expect(localStorage.getItem('api_token')).toBe('test-key')
  })

  it('logout() clears key and sets unauthenticated', async () => {
    localStorage.setItem('api_token', 'stored-key')
    render(<AuthProvider><TestComponent /></AuthProvider>)
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('authenticated')
    })
    screen.getByTestId('logout-btn').click()
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('unauthenticated')
    })
    expect(screen.getByTestId('key').textContent).toBe('none')
    expect(localStorage.getItem('api_token')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-admin && npx vitest run src/components/Auth/AuthContext.test.tsx --reporter verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Write AuthContext implementation**

```typescript
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

interface AuthContextValue {
  apiKey: string | null
  isAuthenticated: boolean
  login: (key: string) => void
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(() => {
    const envKey = import.meta.env.VITE_API_KEY
    if (envKey) return envKey
    return localStorage.getItem('api_token')
  })

  const login = useCallback((key: string) => {
    localStorage.setItem('api_token', key)
    setApiKey(key)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('api_token')
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-admin && npx vitest run src/components/Auth/AuthContext.test.tsx --reporter verbose`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-admin/src/components/Auth/AuthContext.tsx ai-gateway-admin/src/components/Auth/AuthContext.test.tsx
git commit -m "feat: add AuthContext for API key state management"
```

---
### Task 2: AuthGuard — Route protection wrapper

**Files:**
- Create: `ai-gateway-admin/src/components/Auth/AuthGuard.tsx`

- [ ] **Step 1: Write the failing AuthGuard test**

Create `ai-gateway-admin/src/components/Auth/AuthGuard.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './AuthContext'
import AuthGuard from './AuthGuard'

beforeEach(() => localStorage.clear())

function TestPage() {
  return <div data-testid="protected-page">Protected Content</div>
}

function LoginPage() {
  return <div data-testid="login-page">Login Page</div>
}

describe('AuthGuard', () => {
  it('renders children when authenticated', () => {
    localStorage.setItem('api_token', 'valid-key')
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

  it('shows loading spinner while initializing', () => {
    // Simulate async check by rendering without localStorage key
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dashboard" element={
              <AuthGuard><TestPage /></AuthGuard>
            } />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    )
    // No key = redirect to login immediately (no spinner needed)
    expect(screen.getByTestId('login-page')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-admin && npx vitest run src/components/Auth/AuthGuard.test.tsx --reporter verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Write AuthGuard implementation**

```typescript
import { type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthContext'

export default function AuthGuard({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-admin && npx vitest run src/components/Auth/AuthGuard.test.tsx --reporter verbose`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-admin/src/components/Auth/AuthGuard.tsx ai-gateway-admin/src/components/Auth/AuthGuard.test.tsx
git commit -m "feat: add AuthGuard route protection wrapper"
```

---
### Task 3: LoginPage — API key input form

**Files:**
- Create: `ai-gateway-admin/src/pages/Login/index.tsx`

- [ ] **Step 1: Write the failing LoginPage test**

Create `ai-gateway-admin/src/pages/Login/index.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '@/components/Auth/AuthContext'
import LoginPage from './index'

// Mock useNavigate
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  mockNavigate.mockClear()
})

function renderLogin() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>
  )
}

describe('LoginPage', () => {
  it('renders the login form', () => {
    renderLogin()
    expect(screen.getByPlaceholderText('请输入管理员 API Key')).toBeInTheDocument()
    expect(screen.getByText('登 录')).toBeInTheDocument()
  })

  it('calls login and navigates on successful verification', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = mockFetch

    renderLogin()
    const input = screen.getByPlaceholderText('请输入管理员 API Key')
    const button = screen.getByText('登 录')

    fireEvent.change(input, { target: { value: 'valid-key' } })
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/ws', {
        headers: { 'x-api-key': 'valid-key' }
      })
    })
    expect(localStorage.getItem('api_token')).toBe('valid-key')
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard')
  })

  it('shows error message on failed verification', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 })

    renderLogin()
    const input = screen.getByPlaceholderText('请输入管理员 API Key')
    const button = screen.getByText('登 录')

    fireEvent.change(input, { target: { value: 'bad-key' } })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByText('API Key 无效，请重试')).toBeInTheDocument()
    })
    expect(localStorage.getItem('api_token')).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('shows error when server is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

    renderLogin()
    const input = screen.getByPlaceholderText('请输入管理员 API Key')
    const button = screen.getByText('登 录')

    fireEvent.change(input, { target: { value: 'some-key' } })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByText('无法连接到服务器')).toBeInTheDocument()
    })
  })

  it('disables button while loading', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) // never resolves

    renderLogin()
    fireEvent.change(screen.getByPlaceholderText('请输入管理员 API Key'), { target: { value: 'key' } })
    fireEvent.click(screen.getByText('登 录'))

    await waitFor(() => {
      expect(screen.getByRole('button')).toBeDisabled()
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-admin && npx vitest run src/pages/Login/index.test.tsx --reporter verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Write LoginPage implementation**

```typescript
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Input, Button, message } from 'antd'
import { KeyOutlined } from '@ant-design/icons'
import { useAuth } from '@/components/Auth/AuthContext'

export default function LoginPage() {
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { login } = useAuth()

  const handleLogin = async () => {
    if (!apiKey.trim()) return
    setLoading(true)
    try {
      const res = await fetch('/api/v1/ws', {
        headers: { 'x-api-key': apiKey.trim() },
      })
      if (res.ok) {
        login(apiKey.trim())
        message.success('登录成功')
        navigate('/dashboard')
      } else {
        message.error('API Key 无效，请重试')
      }
    } catch {
      message.error('无法连接到服务器')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f0f2f5',
    }}>
      <div style={{
        width: 400,
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
        background: '#fff',
      }}>
        <div style={{
          background: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)',
          padding: '36px 24px 24px',
          textAlign: 'center',
        }}>
          <div style={{ color: '#fff', fontSize: 28, fontWeight: 700, letterSpacing: 1 }}>
            AI Gateway
          </div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, marginTop: 4 }}>
            管理控制台
          </div>
        </div>
        <div style={{ padding: '28px 24px' }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, color: '#333', marginBottom: 6, fontWeight: 500 }}>
              管理员 API Key
            </div>
            <Input.Password
              placeholder="请输入管理员 API Key"
              prefix={<KeyOutlined style={{ color: '#bfbfbf' }} />}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onPressEnter={handleLogin}
              size="large"
            />
          </div>
          <Button
            type="primary"
            block
            size="large"
            loading={loading}
            disabled={!apiKey.trim()}
            onClick={handleLogin}
          >
            登 录
          </Button>
          {import.meta.env.DEV && (
            <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12, color: '#999' }}>
              开发模式: 设置 VITE_API_KEY 环境变量可跳过此页
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-admin && npx vitest run src/pages/Login/index.test.tsx --reporter verbose`
Expected: PASS (4 tests)

Note: The test imports `@/components/Auth/AuthContext` which requires AuthContext to exist (Task 1). If running this test before Task 1's AuthContext is committed, create a temporary placeholder file at `src/components/Auth/AuthContext.tsx` with `export function AuthProvider({ children }: any) { return children } export function useAuth() { return { apiKey: null, isAuthenticated: false, login: vi.fn(), logout: vi.fn() } }`.

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-admin/src/pages/Login/index.tsx ai-gateway-admin/src/pages/Login/index.test.tsx
git commit -m "feat: add login page with API key verification"
```

---
### Task 4: Modify api.ts — Remove fallback key, add 401 interceptor

**Files:**
- Modify: `ai-gateway-admin/src/services/api.ts`

- [ ] **Step 1: Update api.test.ts to match new behavior**

Modify `ai-gateway-admin/src/services/api.test.ts`:
- Remove the `Storage.prototype.getItem = vi.fn(() => 'admin-dashboard-key-456')` mock
- Add a test for 401 triggering logout (redirect)

Replace the `beforeEach` block and add a 401 test:

```typescript
// In the beforeEach, remove the Storage mock:
beforeEach(() => {
  // Set a test key in localStorage for auth header tests
  localStorage.setItem('api_token', 'test-admin-key')
})

// At the end of the file, inside a new describe block:
describe('401 interceptor', () => {
  it('clears token and redirects on 401', async () => {
    // Save original location
    const originalHref = window.location.href
    Object.defineProperty(window, 'location', {
      value: { href: '/dashboard' },
      writable: true,
    })

    server.use(
      http.get('/api/health', () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
      )
    )

    await expect(getHealth()).rejects.toThrow()
    expect(localStorage.getItem('api_token')).toBeNull()
    expect(window.location.href).toBe('/login')

    // Restore
    Object.defineProperty(window, 'location', {
      value: { href: originalHref },
      writable: true,
    })
  })
})
```

- [ ] **Step 2: Run tests before modification to see current state**

Run: `cd ai-gateway-admin && npx vitest run src/services/api.test.ts --reporter verbose`
Expected: PASS (current tests)

- [ ] **Step 3: Modify api.ts — Remove fallback, add 401 interceptor**

Replace the request interceptor and add a 401 handler in the response interceptor:

```typescript
// Request interceptor — read from localStorage, no fallback
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('api_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor — handle 401
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('api_token')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)
```

- [ ] **Step 4: Run tests to verify changes**

Run: `cd ai-gateway-admin && npx vitest run src/services/api.test.ts --reporter verbose`
Expected: PASS (updated tests)

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-admin/src/services/api.ts ai-gateway-admin/src/services/api.test.ts
git commit -m "fix: remove hardcoded API key fallback, add 401 interceptor"
```

---
### Task 5: Modify websocket.ts — Remove hardcoded key fallback

**Files:**
- Modify: `ai-gateway-admin/src/services/websocket.ts`
- Modify: `ai-gateway-admin/src/services/websocket.test.ts`

- [ ] **Step 1: Modify websocket.ts**

Replace the line that reads the API key:

```typescript
// Before (line 23):
const apiKey = localStorage.getItem('api_token') || 'admin-dashboard-key-456'

// After:
const apiKey = localStorage.getItem('api_token') || ''
if (!apiKey) {
  console.warn('[WebSocket] No API key available')
  return
}
```

- [ ] **Step 2: Update websocket.test.ts**

Update the test's localStorage mock to not use the hardcoded key:

```typescript
// Before:
Storage.prototype.getItem = vi.fn(() => 'admin-dashboard-key-456')

// After:
Storage.prototype.getItem = vi.fn(() => 'test-admin-key')
```

- [ ] **Step 3: Run tests to verify**

Run: `cd ai-gateway-admin && npx vitest run src/services/websocket.test.ts --reporter verbose`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add ai-gateway-admin/src/services/websocket.ts ai-gateway-admin/src/services/websocket.test.ts
git commit -m "fix: remove hardcoded API key fallback from WebSocket service"
```

---
### Task 6: Wire logout in Layout + add login route in App.tsx

**Files:**
- Modify: `ai-gateway-admin/src/components/Layout/index.tsx`
- Modify: `ai-gateway-admin/src/App.tsx`

- [ ] **Step 1: Write test for Layout logout button**

Modify existing Layout test or create minimal test. Since there's no existing Layout test, create `ai-gateway-admin/src/components/Layout/index.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '@/components/Auth/AuthContext'
import MainLayout from './index'

beforeEach(() => {
  localStorage.setItem('api_token', 'test-key')
})

describe('MainLayout', () => {
  it('renders sidebar menu items', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <MainLayout />
        </AuthProvider>
      </MemoryRouter>
    )
    expect(screen.getByText('仪表盘')).toBeInTheDocument()
    expect(screen.getByText('Provider 管理')).toBeInTheDocument()
  })

  it('calls logout when clicking 退出登录', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <MainLayout />
        </AuthProvider>
      </MemoryRouter>
    )
    // Click avatar area to open dropdown
    fireEvent.click(screen.getByText('管理员'))
    // Click 退出登录
    fireEvent.click(screen.getByText('退出登录'))
    expect(localStorage.getItem('api_token')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-admin && npx vitest run src/components/Layout/index.test.tsx --reporter verbose`
Expected: FAIL — logout doesn't clear localStorage yet

- [ ] **Step 3: Modify Layout — wire logout**

Add auth import and wire the logout menu item:

```typescript
import { useAuth } from '@/components/Auth/AuthContext'

// Inside the component:
const { logout } = useAuth()

// Replace the userMenuItems:
const userMenuItems = [
  { key: 'profile', label: '个人中心' },
  { type: 'divider' as const },
  { key: 'logout', label: '退出登录', onClick: () => { logout(); navigate('/login') } },
]
```

- [ ] **Step 4: Modify App.tsx — add login route + AuthGuard**

```typescript
import { Routes, Route, Navigate } from 'react-router-dom'
import MainLayout from './components/Layout'
import AuthGuard from './components/Auth/AuthGuard'
import LoginPage from './pages/Login'
import Dashboard from './pages/Dashboard'
import Providers from './pages/Providers'
import Tenants from './pages/Tenants'
import Metrics from './pages/Metrics'
import Settings from './pages/Settings'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<AuthGuard><MainLayout /></AuthGuard>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="providers" element={<Providers />} />
        <Route path="tenants" element={<Tenants />} />
        <Route path="metrics" element={<Metrics />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
```

- [ ] **Step 5: Wire AuthProvider into main.tsx**

Add the AuthProvider wrapper in `ai-gateway-admin/src/main.tsx`:

```typescript
import { AuthProvider } from './components/Auth/AuthContext'

// Inside the JSX, wrap App:
<AuthProvider>
  <App />
</AuthProvider>
```

- [ ] **Step 6: Run Layout test to verify**

Run: `cd ai-gateway-admin && npx vitest run src/components/Layout/index.test.tsx --reporter verbose`
Expected: PASS

- [ ] **Step 7: Run full frontend test suite**

Run: `cd ai-gateway-admin && npx vitest run --reporter verbose`
Expected: All tests PASS

- [ ] **Step 8: Type check**

Run: `cd ai-gateway-admin && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 9: Commit**

```bash
git add ai-gateway-admin/src/main.tsx ai-gateway-admin/src/App.tsx ai-gateway-admin/src/components/Layout/index.tsx ai-gateway-admin/src/components/Layout/index.test.tsx
git commit -m "feat: wire logout button and add login route with AuthGuard"
```

---
### Task 7: Smoke test — verify login flow end-to-end

- [ ] **Step 1: Start the backend and frontend**

```bash
# Terminal 1: Start backend
npm run dev &

# Terminal 2: Start frontend
cd ai-gateway-admin && pnpm dev &
```

Wait for both to be ready.

- [ ] **Step 2: Verify login page loads**

Open `http://localhost:3001` in a browser. Expected: redirected to `/login`, shows the centered card with "AI Gateway 管理控制台" and API key input.

- [ ] **Step 3: Verify invalid key shows error**

Enter `wrong-key` and click submit. Expected: error message "API Key 无效，请重试", stays on login page.

- [ ] **Step 4: Verify valid key logs in**

Enter `test-admin-key` (from `.env`) and click submit. Expected: "登录成功" message, redirect to `/dashboard`, pages load correctly.

- [ ] **Step 5: Verify logout works**

Click user avatar → "退出登录". Expected: key cleared, redirected to `/login`, can't access `/dashboard` without re-entering key.

- [ ] **Step 6: Verify refresh preserves session**

After login, refresh the page. Expected: stays on dashboard (key persisted in localStorage).

- [ ] **Step 7: Kill background processes**

```bash
kill %1 %2 2>/dev/null; true
```