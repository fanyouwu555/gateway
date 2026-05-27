import { Routes, Route, Navigate } from 'react-router-dom'
import MainLayout from './components/Layout'
import AuthGuard from './components/Auth/AuthGuard'
import LoginPage from './pages/Login'
import Dashboard from './pages/Dashboard'
import Providers from './pages/Providers'
import Tenants from './pages/Tenants'
import Metrics from './pages/Metrics'
import Settings from './pages/Settings'
import Plugins from './pages/Plugins'
import CacheManagement from './pages/Cache'
import RouterStatus from './pages/Router'
import Alerts from './pages/Alerts'
import Prompts from './pages/Prompts'
import Sessions from './pages/Sessions'

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
        <Route path="plugins" element={<Plugins />} />
        <Route path="cache" element={<CacheManagement />} />
        <Route path="router" element={<RouterStatus />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="prompts" element={<Prompts />} />
        <Route path="sessions" element={<Sessions />} />
      </Route>
    </Routes>
  )
}

export default App