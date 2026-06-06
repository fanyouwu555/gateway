import { create } from 'zustand'
import { subscribeWithSelector, devtools } from 'zustand/middleware'
import type { DashboardStats, Tenant, Provider, GatewayConfig } from '@/types'

interface AppState {
  stats: DashboardStats | null
  setStats: (stats: DashboardStats) => void
  tenants: Tenant[]
  setTenants: (tenants: Tenant[]) => void
  currentTenant: Tenant | null
  setCurrentTenant: (tenant: Tenant | null) => void
  providers: Provider[]
  setProviders: (providers: Provider[]) => void
  config: GatewayConfig | null
  setConfig: (config: GatewayConfig) => void
  loading: boolean
  setLoading: (loading: boolean) => void
  error: string | null
  setError: (error: string | null) => void
}

export const useStore = create<AppState>()(
  subscribeWithSelector(
    devtools(
      (set) => ({
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
      }),
      { name: 'AppStore', enabled: import.meta.env.DEV }
    )
  )
)