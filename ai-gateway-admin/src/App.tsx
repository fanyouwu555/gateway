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

export default App