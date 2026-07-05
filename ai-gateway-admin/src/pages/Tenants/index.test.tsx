import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import Tenants from './index'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    ...actual,
    getTenants: vi.fn(),
    getTenantStats: vi.fn(),
    getTenantKeys: vi.fn(),
    createTenant: vi.fn(),
    deleteTenant: vi.fn(),
  }
})

import { getTenants, getTenantStats, getTenantKeys, createTenant, deleteTenant } from '@/services/api'

describe('Tenants Page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getTenants as ReturnType<typeof vi.fn>).mockResolvedValue({ tenants: [] })
    ;(getTenantStats as ReturnType<typeof vi.fn>).mockResolvedValue({ total_requests: 0 })
    ;(getTenantKeys as ReturnType<typeof vi.fn>).mockResolvedValue({ keys: [] })
    ;(createTenant as ReturnType<typeof vi.fn>).mockResolvedValue({ tenant_id: 'new' })
    ;(deleteTenant as ReturnType<typeof vi.fn>).mockResolvedValue({ deleted: true })
  })

  it('renders header and fetches tenants on mount', async () => {
    (getTenants as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenants: [
        {
          tenant_id: 't1',
          name: 'Acme',
          plan: 'pro',
          status: 'active',
          settings: { allowed_providers: ['openai'] },
          limits: {},
        },
      ],
    })

    render(<Tenants />)
    expect(screen.getByText('租户管理')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Acme')).toBeInTheDocument()
    })
    expect(getTenants).toHaveBeenCalledTimes(1)
  })

  it('shows tenant plan and status tags', async () => {
    (getTenants as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenants: [
        {
          tenant_id: 't1',
          name: 'Acme',
          plan: 'pro',
          status: 'active',
          settings: {},
          limits: {},
        },
      ],
    })

    render(<Tenants />)
    await waitFor(() => {
      expect(screen.getByText('PRO')).toBeInTheDocument()
      expect(screen.getByText('active')).toBeInTheDocument()
    })
  })

  it('opens create modal and submits new tenant', async () => {
    render(<Tenants />)

    fireEvent.click(screen.getByRole('button', { name: /创建租户/i }))
    await waitFor(() => {
      expect(screen.getByText('创建租户', { selector: '.ant-modal-title' })).toBeInTheDocument()
    })

    fireEvent.change(screen.getByPlaceholderText('租户名称'), {
      target: { value: 'NewCo' },
    })

    // Ant Design default locale is English in tests, so OK button text is 'OK'
    fireEvent.click(screen.getByRole('button', { name: /OK/i }))

    await waitFor(() => {
      expect(createTenant).toHaveBeenCalledWith({
        name: 'NewCo',
        plan: 'free',
        status: 'active',
        limits: {
          daily_requests: 1000,
          daily_tokens: 100000,
          max_api_keys: 5,
          concurrent_requests: 10,
        },
      })
    })
  })

  it('opens detail drawer on view button click', async () => {
    (getTenants as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenants: [
        {
          tenant_id: 't1',
          name: 'Acme',
          plan: 'pro',
          status: 'active',
          settings: {},
          limits: { daily_requests: 1000, daily_tokens: 50000 },
        },
      ],
    })

    render(<Tenants />)
    await waitFor(() => {
      expect(screen.getByText('Acme')).toBeInTheDocument()
    })

    fireEvent.click(screen.getAllByText('详情')[0])

    await waitFor(() => {
      expect(screen.getByText('租户详情')).toBeInTheDocument()
      expect(screen.getAllByText('Acme').length).toBeGreaterThanOrEqual(2)
      expect(screen.getByText('1000')).toBeInTheDocument()
    })
  })

  it('triggers delete on confirm', async () => {
    (getTenants as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenants: [
        {
          tenant_id: 't1',
          name: 'Acme',
          plan: 'pro',
          status: 'active',
          settings: {},
          limits: {},
        },
      ],
    })

    render(<Tenants />)
    await waitFor(() => {
      expect(screen.getByText('Acme')).toBeInTheDocument()
    })

    fireEvent.click(screen.getAllByText('删除')[0])

    // Popconfirm should appear; confirm deletion (default Ant Design locale is English)
    const confirmButton = await screen.findByRole('button', { name: /^OK$/i })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(deleteTenant).toHaveBeenCalledWith('t1')
    })
  })
})
