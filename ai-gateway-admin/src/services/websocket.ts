type MessageHandler = (data: unknown) => void

interface WebSocketServiceOptions {
  onOpen?: () => void
  onClose?: () => void
  onError?: (error: Event) => void
  onMessage?: MessageHandler
}

class WebSocketService {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 3000
  private messageHandlers: Map<string, Set<MessageHandler>> = new Map()
  private globalHandlers: Set<MessageHandler> = new Set()
  private url: string = ''
  private options: WebSocketServiceOptions = {}

  connect(tenantId: string = 'admin', options?: WebSocketServiceOptions) {
    this.options = options || {}
    const baseUrl = import.meta.env.VITE_WS_BASE_URL || 'ws://localhost:3000'
    const apiKey = localStorage.getItem('api_token') || ''
    if (!apiKey) {
      console.warn('[WebSocket] No API key available')
      return
    }
    this.url = `${baseUrl}/v1/ws?tenant_id=${encodeURIComponent(tenantId)}&api_key=${encodeURIComponent(apiKey)}`

    try {
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        console.log('[WebSocket] Connected')
        this.reconnectAttempts = 0
        this.options.onOpen?.()
      }

      this.ws.onclose = (event) => {
        console.log('[WebSocket] Disconnected', event.code, event.reason)
        this.options.onClose?.()
        this.attemptReconnect()
      }

      this.ws.onerror = (error) => {
        console.error('[WebSocket] Error:', error)
        this.options.onError?.(error)
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          this.handleMessage(data)
        } catch (error) {
          console.error('[WebSocket] Failed to parse message:', error)
        }
      }
    } catch (error) {
      console.error('[WebSocket] Failed to connect:', error)
      this.attemptReconnect()
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WebSocket] Max reconnect attempts reached')
      return
    }

    this.reconnectAttempts++
    console.log(`[WebSocket] Reconnecting... Attempt ${this.reconnectAttempts}`)

    setTimeout(() => {
      this.connect()
    }, this.reconnectDelay)
  }

  private handleMessage(raw: unknown) {
    this.options.onMessage?.(raw)

    // 按类型分发
    const data = raw as Record<string, unknown>
    const type = ((data.type as string | undefined) || (data.event as string | undefined))
    if (type && this.messageHandlers.has(type)) {
      this.messageHandlers.get(type)!.forEach((handler) => handler(raw))
    }

    // 全局处理器
    this.globalHandlers.forEach((handler) => handler(raw))
  }

  on(type: string, handler: MessageHandler) {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set())
    }
    this.messageHandlers.get(type)!.add(handler)
  }

  off(type: string, handler: MessageHandler) {
    if (this.messageHandlers.has(type)) {
      this.messageHandlers.get(type)!.delete(handler)
    }
  }

  onAny(handler: MessageHandler) {
    this.globalHandlers.add(handler)
  }

  offAny(handler: MessageHandler) {
    this.globalHandlers.delete(handler)
  }

  send(message: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
      console.warn('[WebSocket] Cannot send: not connected')
    }
  }

  disconnect() {
    if (this.ws) {
      // 移除 onclose 监听器，防止触发自动重连
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
    this.messageHandlers.clear()
    this.globalHandlers.clear()
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

export const wsService = new WebSocketService()
