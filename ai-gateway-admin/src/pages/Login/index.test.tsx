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
      const button = screen.getByRole('button')
      expect(button.classList.contains('ant-btn-loading')).toBe(true)
    })
  })
})
