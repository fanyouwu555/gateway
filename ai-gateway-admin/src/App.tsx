import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Spin } from 'antd'
import MainLayout from './components/Layout'
import AuthGuard from './components/Auth/AuthGuard'

const LoginPage = lazy(() => import('./pages/Login'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Providers = lazy(() => import('./pages/Providers'))
const Tenants = lazy(() => import('./pages/Tenants'))
const TenantTemplates = lazy(() => import('./pages/TenantTemplates'))
const Metrics = lazy(() => import('./pages/Metrics'))
const Settings = lazy(() => import('./pages/Settings'))
const Plugins = lazy(() => import('./pages/Plugins'))
const CacheManagement = lazy(() => import('./pages/Cache'))
const RouterStatus = lazy(() => import('./pages/Router'))
const Alerts = lazy(() => import('./pages/Alerts'))
const Prompts = lazy(() => import('./pages/Prompts'))
const Conversations = lazy(() => import('./pages/Conversations'))

function PageLoader() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <Spin size="large" />
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Suspense fallback={<PageLoader />}><LoginPage /></Suspense>} />
      <Route path="/" element={<AuthGuard><MainLayout /></AuthGuard>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Suspense fallback={<PageLoader />}><Dashboard /></Suspense>} />
        <Route path="providers" element={<Suspense fallback={<PageLoader />}><Providers /></Suspense>} />
        <Route path="tenants" element={<Suspense fallback={<PageLoader />}><Tenants /></Suspense>} />
        <Route path="tenant-templates" element={<Suspense fallback={<PageLoader />}><TenantTemplates /></Suspense>} />
        <Route path="metrics" element={<Suspense fallback={<PageLoader />}><Metrics /></Suspense>} />
        <Route path="settings" element={<Suspense fallback={<PageLoader />}><Settings /></Suspense>} />
        <Route path="plugins" element={<Suspense fallback={<PageLoader />}><Plugins /></Suspense>} />
        <Route path="cache" element={<Suspense fallback={<PageLoader />}><CacheManagement /></Suspense>} />
        <Route path="router" element={<Suspense fallback={<PageLoader />}><RouterStatus /></Suspense>} />
        <Route path="alerts" element={<Suspense fallback={<PageLoader />}><Alerts /></Suspense>} />
        <Route path="prompts" element={<Suspense fallback={<PageLoader />}><Prompts /></Suspense>} />
        <Route path="conversations" element={<Suspense fallback={<PageLoader />}><Conversations /></Suspense>} />
      </Route>
    </Routes>
  )
}

export default App