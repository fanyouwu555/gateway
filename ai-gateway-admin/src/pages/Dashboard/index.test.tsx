import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import Dashboard from './index'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    ...actual,
    getHealth: vi.fn(),
    getCacheStats: vi.fn(),
    getDashboardOverview: vi.fn(),
    getTimeSeriesMetrics: vi.fn(),
    getProviderStats: vi.fn(),
    getStatusCodeStats: vi.fn(),
    getRequestLogs: vi.fn(),
  }
})

vi.mock('@/services/websocket', () => ({
  wsService: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
  },
}))

vi.mock('@/components/common/StatsCard', () => ({
  default: ({ title, value, suffix }: { title: string; value: string; suffix?: string }) => (
    <div data-testid="stats-card">
      <span>{title}</span>
      <span>{value}{suffix}</span>
    </div>
  ),
}))

vi.mock('@/components/Charts/LineChart', () => ({
  default: () => <div data-testid="line-chart">LineChart</div>,
}))

vi.mock('@/components/Charts/PieChart', () => ({
  default: () => <div data-testid="pie-chart">PieChart</div>,
}))

vi.mock('@/components/Charts/BarChart', () => ({
  default: () => <div data-testid="bar-chart">BarChart</div>,
}))

import { getHealth, getCacheStats, getDashboardOverview, getTimeSeriesMetrics, getProviderStats, getStatusCodeStats, getRequestLogs } from '@/services/api'
import { wsService } from '@/services/websocket'

describe('Dashboard Page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'ok',
      services: { providers: [{ name: 'openai', status: 'active' }] },
      version: '1.0.0',
      uptime: 3600,
    })
    ;(getCacheStats as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 10, hit_rate: 0.9 })
    ;(getDashboardOverview as ReturnType<typeof vi.fn>).mockResolvedValue({
      total_requests: 1000,
      total_tokens: 50000,
      total_providers: 2,
      total_models: 5,
      avg_duration_ms: 120,
      success_rate: 0.98,
      error_rate: 0.02,
      total_tenants: 3,
    })
    ;(getTimeSeriesMetrics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { time_label: '00:00', total_requests: 10, total_tokens: 100 },
    ])
    ;(getProviderStats as ReturnType<typeof vi.fn>).mockResolvedValue([
      { provider: 'openai', total_requests: 800 },
    ])
    ;(getStatusCodeStats as ReturnType<typeof vi.fn>).mockResolvedValue({ 200: 950, 500: 50 })
    ;(getRequestLogs as ReturnType<typeof vi.fn>).mockResolvedValue({ logs: [], total: 0 })
  })

  it('renders dashboard header and connects WebSocket', () => {
    render(<Dashboard />)
    expect(screen.getByText('AI Gateway 仪表盘')).toBeInTheDocument()
    expect(wsService.connect).toHaveBeenCalledWith('admin', expect.any(Object))
  })

  it('fetches and displays overview stats', async () => {
    render(<Dashboard />)
    await waitFor(() => {
      expect(screen.getByText('总请求数')).toBeInTheDocument()
      expect(screen.getByText('1,000')).toBeInTheDocument()
    })
    expect(getDashboardOverview).toHaveBeenCalled()
  })

  it('shows provider status from health data', async () => {
    render(<Dashboard />)
    await waitFor(() => {
      expect(screen.getByText('openai:')).toBeInTheDocument()
      expect(screen.getByText('active')).toBeInTheDocument()
    })
  })

  it('renders charts after data load', async () => {
    render(<Dashboard />)
    await waitFor(() => {
      expect(screen.getAllByTestId('line-chart').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByTestId('pie-chart')).toBeInTheDocument()
      expect(screen.getByTestId('bar-chart')).toBeInTheDocument()
    })
  })

  it('changes time range and re-fetches data', async () => {
    render(<Dashboard />)
    await waitFor(() => {
      expect(screen.getByText('AI Gateway 仪表盘')).toBeInTheDocument()
    })

    const select = screen.getByRole('combobox')
    fireEvent.mouseDown(select)

    const option = await screen.findByText('最近 7 天')
    fireEvent.click(option)

    await waitFor(() => {
      expect(getDashboardOverview).toHaveBeenCalledTimes(2)
    })
  })

  it('disconnects WebSocket on unmount', () => {
    const { unmount } = render(<Dashboard />)
    unmount()
    expect(wsService.disconnect).toHaveBeenCalled()
  })
})
