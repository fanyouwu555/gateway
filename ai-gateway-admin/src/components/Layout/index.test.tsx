import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '@/components/Auth/AuthContext'
import MainLayout from './index'

beforeEach(() => {
  localStorage.setItem('api_token', 'test-key')
})

afterEach(() => {
  localStorage.clear()
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

  it('calls logout when clicking 退出登录', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <MainLayout />
        </AuthProvider>
      </MemoryRouter>
    )
    // Click avatar area to open dropdown
    await user.click(screen.getByText('管理员'))
    // Wait for dropdown to render in portal and click 退出登录
    const logoutItem = await screen.findByText('退出登录')
    await user.click(logoutItem)
    expect(localStorage.getItem('api_token')).toBeNull()
  })
})
