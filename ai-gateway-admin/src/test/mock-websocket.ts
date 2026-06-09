export class MockWebSocket {
  static instances: MockWebSocket[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  url: string
  protocols: string | string[] = []
  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  sentMessages: unknown[] = []
  private listeners: Map<string, Set<(event: unknown) => void>> = new Map()

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url)
    this.protocols = protocols ?? []
    MockWebSocket.instances.push(this)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sentMessages.push(data)
  }

  close(code?: number, reason?: string) {
    this.readyState = 3 // CLOSED
    const ev = { code: code ?? 1000, reason: reason ?? '' } as CloseEvent
    this.onclose?.(ev)
    this.listeners.get('close')?.forEach((l) => l(ev))
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  static clear() {
    MockWebSocket.instances = []
  }

  simulateOpen() {
    this.readyState = 1 // OPEN
    const ev = new Event('open')
    this.onopen?.(ev)
    this.listeners.get('open')?.forEach((l) => l(ev))
  }

  simulateMessage(data: unknown) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    const ev = new MessageEvent('message', { data: payload })
    this.onmessage?.(ev)
    this.listeners.get('message')?.forEach((l) => l(ev))
  }

  simulateError() {
    const ev = new Event('error')
    this.onerror?.(ev)
    this.listeners.get('error')?.forEach((l) => l(ev))
  }

  simulateClose(code = 1000, reason = '') {
    this.readyState = 3
    const ev = { code, reason } as CloseEvent
    this.onclose?.(ev)
    this.listeners.get('close')?.forEach((l) => l(ev))
  }
}

Object.defineProperty(globalThis, 'WebSocket', {
  value: MockWebSocket,
  writable: true,
})
