import '@testing-library/jest-dom/vitest'
import './antd-polyfill'
import { MockWebSocket } from './mock-websocket'
import { server } from './server'

// Mock import.meta.env for tests
Object.defineProperty(globalThis, 'import', {
  value: {
    meta: {
      env: {
        VITE_API_BASE_URL: '/api',
        VITE_WS_BASE_URL: 'ws://localhost:3000',
      },
    },
  },
  writable: true,
})

beforeAll(() => {
  // MSW may patch global WebSocket; restore our mock afterward
  Object.defineProperty(globalThis, 'WebSocket', {
    value: MockWebSocket,
    writable: true,
  })
  server.listen({ onUnhandledRequest: 'warn' })
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
