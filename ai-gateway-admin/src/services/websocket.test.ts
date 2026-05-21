import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { MockWebSocket } from '@/test/mock-websocket'
import { server } from '@/test/server'
import { wsService } from './websocket'

describe('WebSocketService', () => {
  beforeAll(() => server.close())
  afterAll(() => server.listen({ onUnhandledRequest: 'warn' }))

  beforeEach(() => {
    MockWebSocket.clear()
    Object.defineProperty(globalThis, 'WebSocket', {
      value: MockWebSocket,
      writable: true,
    })
    Storage.prototype.getItem = vi.fn(() => 'admin-dashboard-key-456')
    wsService.disconnect()
    // @ts-expect-error accessing private field for test cleanup
    wsService.reconnectAttempts = 0
  })

  afterEach(() => {
    wsService.disconnect()
    vi.useRealTimers()
  })

  it('connect builds correct URL with tenantId and api_key', () => {
    wsService.connect('tenant-1')
    expect(MockWebSocket.instances.length).toBe(1)
    const ws = MockWebSocket.instances[0]
    expect(ws.url).toBe('ws://localhost:3000/v1/ws/tenant-1?api_key=admin-dashboard-key-456')
  })

  it('calls onOpen when connection opens', () => {
    const onOpen = vi.fn()
    wsService.connect('admin', { onOpen })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('dispatches typed message handlers', () => {
    const handler = vi.fn()
    wsService.connect('admin')
    wsService.on('metrics', handler)

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ type: 'metrics', value: 42 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'metrics', value: 42 }))
  })

  it('dispatches global handlers for any message', () => {
    const globalHandler = vi.fn()
    wsService.connect('admin')
    wsService.onAny(globalHandler)

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ event: 'ping' })

    expect(globalHandler).toHaveBeenCalledTimes(1)
  })

  it('off removes typed handler', () => {
    const handler = vi.fn()
    wsService.connect('admin')
    wsService.on('metrics', handler)
    wsService.off('metrics', handler)

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ type: 'metrics', value: 42 })

    expect(handler).not.toHaveBeenCalled()
  })

  it('offAny removes global handler', () => {
    const handler = vi.fn()
    wsService.connect('admin')
    wsService.onAny(handler)
    wsService.offAny(handler)

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ event: 'ping' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('send serializes and sends message when open', () => {
    wsService.connect('admin')
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    wsService.send({ action: 'subscribe', channel: 'metrics' })
    expect(ws.sentMessages).toHaveLength(1)
    expect(ws.sentMessages[0]).toBe('{"action":"subscribe","channel":"metrics"}')
  })

  it('warns when sending while not connected', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wsService.connect('admin')
    // Do not simulate open

    wsService.send({ action: 'test' })
    expect(warnSpy).toHaveBeenCalledWith('[WebSocket] Cannot send: not connected')
    warnSpy.mockRestore()
  })

  it('isConnected returns true only when OPEN', () => {
    wsService.connect('admin')
    expect(wsService.isConnected()).toBe(false)

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    expect(wsService.isConnected()).toBe(true)

    ws.simulateClose()
    expect(wsService.isConnected()).toBe(false)
  })

  it('disconnect closes socket and clears handlers', () => {
    const handler = vi.fn()
    wsService.connect('admin')
    wsService.on('metrics', handler)

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    wsService.disconnect()

    expect(ws.readyState).toBe(3)
    expect(wsService.isConnected()).toBe(false)
  })

  it('attempts reconnect after close', () => {
    vi.useFakeTimers()
    wsService.connect('admin')
    const firstWs = MockWebSocket.instances[0]
    firstWs.simulateOpen()

    // Simulate server close
    firstWs.simulateClose()

    // Fast-forward past reconnect delay
    vi.advanceTimersByTime(3500)

    expect(MockWebSocket.instances.length).toBe(2)
  })

  it('stops reconnecting after max attempts', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    wsService.connect('admin')

    for (let i = 0; i < 6; i++) {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      ws.simulateClose()
      vi.advanceTimersByTime(3500)
    }

    expect(MockWebSocket.instances.length).toBe(6)
    expect(errorSpy).toHaveBeenCalledWith('[WebSocket] Max reconnect attempts reached')

    errorSpy.mockRestore()
  })

  it('calls onError when socket errors', () => {
    const onError = vi.fn()
    wsService.connect('admin', { onError })

    const ws = MockWebSocket.instances[0]
    ws.simulateError()

    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when socket closes', () => {
    const onClose = vi.fn()
    wsService.connect('admin', { onClose })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateClose()

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
