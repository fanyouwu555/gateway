import { Routes, Route, Navigate } from 'react-router-dom'
import MainLayout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Providers from './pages/Providers'
import Tenants from './pages/Tenants'
import Metrics from './pages/Metrics'
import Settings from './pages/Settings'

function App() {
  return (
    <Routes>
      <Route path="/" element={<MainLayout />}>
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