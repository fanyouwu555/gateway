import { create } from 'zustand'
import type { DashboardStats, Tenant, Provider, GatewayConfig } from '@/types'

interface AppState {
  // 统计数据
  stats: DashboardStats | null
  setStats: (stats: DashboardStats) => void

  // 租户列表
  tenants: Tenant[]
  setTenants: (tenants: Tenant[]) => void

  // 当前租户
  currentTenant: Tenant | null
  setCurrentTenant: (tenant: Tenant | null) => void

  // Provider 列表
  providers: Provider[]
  setProviders: (providers: Provider[]) => void

  // 配置
  config: GatewayConfig | null
  setConfig: (config: GatewayConfig) => void

  // 加载状态
  loading: boolean
  setLoading: (loading: boolean) => void

  // 错误
  error: string | null
  setError: (error: string | null) => void
}

export const useStore = create<AppState>((set) => ({
  stats: null,
  tenants: [],
  currentTenant: null,
  providers: [],
  config: null,
  loading: false,
  error: null,
  setStats: (stats) => set({ stats }),
  setTenants: (tenants) => set({ tenants }),
  setCurrentTenant: (tenant) => set({ currentTenant: tenant }),
  setProviders: (providers) => set({ providers }),
  setConfig: (config) => set({ config }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}))