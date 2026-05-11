/**
 * WebSocket 支持
 * 支持实时AI对话
 */
import type { Context, Next } from 'hono';
import type { Server } from 'http';
import type { ChatCompletionRequest } from '../types';
import { generateRequestId } from '../utils';
import { getProviderForModel } from '../config';
import { chatCompleteStream } from '../providers';

/**
 * WebSocket 连接信息
 */
interface WSConnection {
  id: string;
  tenant_id: string;
  model: string;
  connected_at: number;
  last_activity: number;
}

/**
 * WebSocket 管理器
 */
class WebSocketManager {
  private connections = new Map<string, WSConnection>();

  /**
   * 初始化WebSocket服务器
   */
  init(_server: Server): void {
    // WebSocket支持需要单独处理，这里提供基础框架
    console.log('[WebSocket] Manager initialized');
  }

  /**
   * 添加连接
   */
  addConnection(tenantId: string, model: string): string {
    const id = `ws_${generateRequestId()}`;
    this.connections.set(id, {
      id,
      tenant_id: tenantId,
      model,
      connected_at: Date.now(),
      last_activity: Date.now(),
    });
    return id;
  }

  /**
   * 移除连接
   */
  removeConnection(id: string): boolean {
    return this.connections.delete(id);
  }

  /**
   * 更新活跃时间
   */
  updateActivity(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.last_activity = Date.now();
    }
  }

  /**
   * 获取连接
   */
  getConnection(id: string): WSConnection | null {
    return this.connections.get(id) || null;
  }

  /**
   * 获取租户连接数
   */
  getTenantConnections(tenantId: string): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.tenant_id === tenantId) {
        count++;
      }
    }
    return count;
  }

  /**
   * 清理过期连接
   */
  clean(): number {
    const now = Date.now();
    const maxIdle = 300000; // 5分钟
    let count = 0;

    for (const [id, conn] of this.connections.entries()) {
      if (now - conn.last_activity > maxIdle) {
        this.connections.delete(id);
        count++;
      }
    }

    return count;
  }

  /**
   * 获取统计
   */
  getStats(): { total: number; by_tenant: Record<string, number> } {
    const byTenant: Record<string, number> = {};

    for (const conn of this.connections.values()) {
      byTenant[conn.tenant_id] = (byTenant[conn.tenant_id] || 0) + 1;
    }

    return {
      total: this.connections.size,
      by_tenant: byTenant,
    };
  }
}

// 单例
const wsManager = new WebSocketManager();

/**
 * 初始化WebSocket
 */
export function initWebSocket(server: Server): void {
  wsManager.init(server);
}

/**
 * 处理WebSocket连接（握手）
 */
export async function handleWebSocketHandshake(c: Context, next: Next): Promise<void> {
  const upgrade = c.req.header('upgrade');

  if (upgrade === 'websocket') {
    // WebSocket握手处理
    // 注意：生产环境需要使用 @hono/node-ws 或原生ws库
    const tenantId = c.get('tenant_id') || 'default';
    const model = c.req.query('model') || 'gpt-4o-mini';

    // 创建连接记录
    const connId = wsManager.addConnection(tenantId, model);

    // 设置响应头表示接受WebSocket
    c.status(101);
    c.text('WebSocket handshake not implemented in this version');

    // 注意：完整WebSocket支持需要额外配置
    console.log(`[WebSocket] Connection request: ${connId}, model: ${model}`);
  } else {
    await next();
  }
}

/**
 * 发送WebSocket消息
 */
export function sendWSMessage(connectionId: string, data: unknown): boolean {
  const conn = wsManager.getConnection(connectionId);
  if (!conn) return false;

  wsManager.updateActivity(connectionId);
  // 实际发送需要完整的WebSocket实现
  console.log(`[WebSocket] Would send to ${connectionId}:`, JSON.stringify(data).slice(0, 100));
  return true;
}

/**
 * 广播消息
 */
export function broadcastToTenant(tenantId: string, _data: unknown): number {
  // 实际广播需要完整的WebSocket实现
  console.log(`[WebSocket] Would broadcast to tenant ${tenantId}`);
  return 0;
}

/**
 * 关闭连接
 */
export function closeConnection(connectionId: string): boolean {
  return wsManager.removeConnection(connectionId);
}

/**
 * 获取WebSocket统计
 */
export function getWebSocketStats() {
  return wsManager.getStats();
}

/**
 * 清理过期连接
 */
export function cleanWebSocketConnections(): number {
  return wsManager.clean();
}

/**
 * 实时聊天处理（HTTP轮询方式，适合不支持WebSocket的场景）
 */
export async function handleRealtimeChat(c: Context): Promise<Response> {
  try {
    const request = await c.req.json() as ChatCompletionRequest;
    const model = request.model;

    if (!model) {
      return c.json(
        { error: { message: 'Missing model', type: 'invalid_request_error' } },
        400
      );
    }

    const providerName = getProviderForModel(model);
    if (!providerName) {
      return c.json(
        { error: { message: `No provider for model: ${model}`, type: 'invalid_request_error' } },
        400
      );
    }

    // 确保流式开启
    request.stream = true;

    const stream = await chatCompleteStream(providerName, request);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json(
      { error: { message, type: 'provider_error' } },
      500
    );
  }
}