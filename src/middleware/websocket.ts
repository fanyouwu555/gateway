/**
 * WebSocket 支持
 * 支持实时 AI 对话流式传输
 * 协议兼容 OpenAI SSE 格式
 */
import type { Context, Next } from 'hono';
import type { WebSocket } from 'ws';
import type { ChatCompletionRequest } from '../types';
import { generateRequestId } from '../utils';
import { getProviderForModel, getConfig, resolveModelAlias } from '../config';
import { chatCompleteStream } from '../providers';
import { writeLog } from '../utils/logger';
import { checkQuota, recordUsage, checkKeyQuota } from '../services/quota';
import { runGuardrailPlugins, runRequestPlugins } from '../plugins';
import { smartRoute, type RouterStrategy } from '../services/router';
import type { ChatMessage } from '../types';
import { countPromptTokens, countCompletionTokens, accumulateStreamContent } from '../services/token-counter';

/**
 * WebSocket 消息类型
 */
export type WSMessageType =
  | 'chat.completion'
  | 'chat.completion.chunk'
  | 'ping'
  | 'pong'
  | 'error'
  | 'close';

/**
 * WebSocket 消息格式
 */
export interface WSMessage {
  type: WSMessageType;
  id?: string;
  payload?: unknown;
  error?: {
    message: string;
    type: string;
    code?: string;
  };
}

/**
 * WebSocket 连接信息
 */
export interface WSConnection {
  id: string;
  ws: WebSocket;
  tenant_id: string;
  model: string;
  connected_at: number;
  last_activity: number;
  abort_controller?: AbortController;
  /** 虚拟密钥策略字段（由 auth middleware 设置，可选以兼容旧连接） */
  key_hash?: string;
  key_allowed_models?: string[];
  key_monthly_budget?: number;
  key_max_tokens?: number;
  key_metadata?: Record<string, unknown>;
}

/**
 * WebSocket 管理器
 */
class WebSocketManager {
  private connections = new Map<string, WSConnection>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30s ping
  private readonly METRICS_INTERVAL = 5000; // 5s metrics broadcast
  private readonly MAX_IDLE_TIME = 300000; // 5分钟超时

  /**
   * 启动心跳检测
   */
  startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of this.connections.entries()) {
        // 检查空闲超时
        if (now - conn.last_activity > this.MAX_IDLE_TIME) {
          writeLog('info', '[WebSocket] Connection idle timeout', { connection_id: id });
          this.closeConnection(id, 1008, 'Idle timeout');
          continue;
        }

        // 发送 ping
        if (conn.ws.readyState === 1) { // OPEN
          try {
            conn.ws.ping();
          } catch (e) {
            writeLog('warn', '[WebSocket] Failed to send ping', { connection_id: id });
          }
        }
      }
      // 清理过期连接
      this.clean();
    }, this.HEARTBEAT_INTERVAL);

    this.heartbeatInterval.unref();
    writeLog('info', '[WebSocket] Heartbeat started');
  }

  /**
   * 停止心跳检测
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * 启动实时指标广播
   */
  startMetricsBroadcast(): void {
    if (this.metricsInterval) return;

    this.metricsInterval = setInterval(() => {
      // 动态导入避免循环依赖
      import('../services/metrics.js')
        .then(({ getDashboardOverview }) => {
          const now = Date.now();
          const start = now - 60 * 60 * 1000; // 最近 1 小时
          const overview = getDashboardOverview(start, now);

          const message = {
            type: 'metrics_update',
            event: 'metrics_update',
            ...overview,
          };

          // 广播给所有 admin 连接
          for (const conn of this.connections.values()) {
            if (conn.tenant_id === 'admin' && conn.ws.readyState === 1) {
              try {
                conn.ws.send(JSON.stringify(message));
              } catch {
                // 忽略发送错误
              }
            }
          }
        })
        .catch(() => {
          // 静默失败，不影响主流程
        });
    }, this.METRICS_INTERVAL);

    this.metricsInterval.unref();
    writeLog('info', '[WebSocket] Metrics broadcast started');
  }

  /**
   * 停止实时指标广播
   */
  stopMetricsBroadcast(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
  }

  /**
   * 添加连接
   */
  addConnection(ws: WebSocket, tenantId: string, model: string, keyPolicy?: {
    key_hash?: string;
    key_allowed_models?: string[];
    key_monthly_budget?: number;
    key_max_tokens?: number;
    key_metadata?: Record<string, unknown>;
  }): string {
    const id = `ws_${generateRequestId()}`;

    const connection: WSConnection = {
      id,
      ws,
      tenant_id: tenantId,
      model,
      connected_at: Date.now(),
      last_activity: Date.now(),
      ...keyPolicy,
    };

    this.connections.set(id, connection);
    writeLog('info', '[WebSocket] Connection established', {
      connection_id: id,
      tenant_id: tenantId,
      model,
      total_connections: this.connections.size,
    });

    return id;
  }

  /**
   * 移除连接
   */
  removeConnection(id: string): boolean {
    const conn = this.connections.get(id);
    if (conn) {
      try {
        if (conn.abort_controller) {
          conn.abort_controller.abort();
        }
        if (conn.ws.readyState === 1) {
          conn.ws.close(1000, 'Normal closure');
        }
      } catch (e) {
        // 忽略关闭错误
      }
    }
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
   * 通过 WebSocket 实例获取连接 ID
   */
  getConnectionIdByWS(ws: WebSocket): string | null {
    for (const [id, conn] of this.connections.entries()) {
      if (conn.ws === ws) {
        return id;
      }
    }
    return null;
  }

  /**
   * 关闭连接
   */
  closeConnection(id: string, code = 1000, reason = 'Normal closure'): boolean {
    const conn = this.connections.get(id);
    if (!conn) return false;

    try {
      if (conn.abort_controller) {
        conn.abort_controller.abort();
      }
      if (conn.ws.readyState === 1) {
        conn.ws.close(code, reason);
      }
    } catch (e) {
      writeLog('warn', '[WebSocket] Error closing connection', {
        connection_id: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    this.connections.delete(id);
    writeLog('info', '[WebSocket] Connection closed', {
      connection_id: id,
      code,
      reason,
      total_connections: this.connections.size,
    });

    return true;
  }

  /**
   * 获取租户连接列表
   */
  getConnectionsByTenant(tenantId: string): WSConnection[] {
    const result: WSConnection[] = [];
    for (const conn of this.connections.values()) {
      if (conn.tenant_id === tenantId) {
        result.push(conn);
      }
    }
    return result;
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
   * 清除所有连接（用于测试）
   */
  clear(): void {
    for (const id of this.connections.keys()) {
      this.closeConnection(id, 1001, 'Server restart');
    }
    this.connections.clear();
    this.stopMetricsBroadcast();
  }

  /**
   * 清理过期连接
   */
  clean(): number {
    const now = Date.now();
    let count = 0;

    for (const [id, conn] of this.connections.entries()) {
      // 检查空闲超时或已关闭的连接
      if (
        now - conn.last_activity > this.MAX_IDLE_TIME ||
        conn.ws.readyState > 1 // CLOSING or CLOSED
      ) {
        this.connections.delete(id);
        count++;
      }
    }

    if (count > 0) {
      writeLog('debug', '[WebSocket] Cleaned idle connections', { count });
    }

    return count;
  }

  /**
   * 向租户的所有连接广播消息
   */
  broadcastToTenant(tenantId: string, message: unknown): void {
    for (const conn of this.connections.values()) {
      if (conn.tenant_id === tenantId && conn.ws.readyState === 1) {
        try {
          conn.ws.send(JSON.stringify(message));
        } catch (e) {
          writeLog('warn', '[WebSocket] Failed to broadcast message', {
            tenant_id: tenantId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  /**
   * 广播请求完成事件（用于管理面板实时更新）
   */
  broadcastRequestComplete(data: {
    request_id: string;
    tenant_id: string;
    model: string;
    provider: string;
    duration_ms: number;
    total_tokens: number;
    status: 'success' | 'error';
    error?: string;
  }): void {
    const message = {
      type: 'request_complete',
      event: 'request_complete',
      ...data,
    };

    // 广播给所有管理连接（tenant_id 以 admin 开头或特定的 admin 租户）
    for (const conn of this.connections.values()) {
      if (conn.tenant_id === 'admin' && conn.ws.readyState === 1) {
        try {
          conn.ws.send(JSON.stringify(message));
        } catch (e) {
          // 忽略发送错误
        }
      }
    }
  }

  /**
   * 获取统计
   */
  getStats(): {
    total: number;
    by_tenant: Record<string, number>;
    uptime: number;
  } {
    const byTenant: Record<string, number> = {};

    for (const conn of this.connections.values()) {
      byTenant[conn.tenant_id] = (byTenant[conn.tenant_id] || 0) + 1;
    }

    return {
      total: this.connections.size,
      by_tenant: byTenant,
      uptime: 0, // TODO: 跟踪管理器启动时间
    };
  }

  /**
   * 发送消息
   */
  send(connectionId: string, message: WSMessage): boolean {
    const conn = this.getConnection(connectionId);
    if (!conn || conn.ws.readyState !== 1) {
      return false;
    }

    try {
      conn.ws.send(JSON.stringify(message));
      this.updateActivity(connectionId);
      return true;
    } catch (e) {
      writeLog('warn', '[WebSocket] Failed to send message', {
        connection_id: connectionId,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /**
   * 设置连接的 AbortController
   */
  setAbortController(connectionId: string, controller: AbortController | null): void {
    const conn = this.getConnection(connectionId);
    if (conn) {
      conn.abort_controller = controller || undefined;
    }
  }
}

// 单例
const wsManager = new WebSocketManager();

/**
 * 初始化 WebSocket 管理器
 */
export function initWebSocket(): void {
  wsManager.startHeartbeat();
  wsManager.startMetricsBroadcast();
  writeLog('info', '[WebSocket] Manager initialized');
}

/**
 * 获取 WebSocket 管理器实例
 */
export function getWebSocketManager(): WebSocketManager {
  return wsManager;
}

/**
 * 处理 WebSocket 连接建立
 */
export function handleWSConnection(ws: WebSocket, ctx: Context): void {
  const tenantId = ctx.get('tenant_id') || 'default';
  const model = ctx.req.query('model') || getConfig().default_model || 'gpt-4o-mini';

  const connectionId = wsManager.addConnection(ws, tenantId, model, {
    key_hash: ctx.get('key_hash'),
    key_allowed_models: ctx.get('key_allowed_models'),
    key_monthly_budget: ctx.get('key_monthly_budget'),
    key_max_tokens: ctx.get('key_max_tokens_per_request'),
    key_metadata: ctx.get('key_metadata'),
  });

  // 消息处理
  ws.on('message', async (data: Buffer) => {
    wsManager.updateActivity(connectionId);
    await handleWSMessage(connectionId, data.toString());
  });

  // 关闭处理
  ws.on('close', (code: number, reason: Buffer) => {
    writeLog('debug', '[WebSocket] Client closed connection', {
      connection_id: connectionId,
      code,
      reason: reason.toString(),
    });
    wsManager.removeConnection(connectionId);
  });

  // 错误处理
  ws.on('error', (error: Error) => {
    writeLog('error', '[WebSocket] Connection error', {
      connection_id: connectionId,
      error: error.message,
    });
    wsManager.removeConnection(connectionId);
  });

  // pong 响应
  ws.on('pong', () => {
    wsManager.updateActivity(connectionId);
  });

  // 发送欢迎消息
  wsManager.send(connectionId, {
    type: 'chat.completion',
    id: connectionId,
    payload: {
      status: 'connected',
      message: 'WebSocket connection established. Send chat.completion requests to start streaming.',
      model,
    },
  });
}

/**
 * 处理 WebSocket 消息
 */
async function handleWSMessage(connectionId: string, data: string): Promise<void> {
  const conn = wsManager.getConnection(connectionId);
  if (!conn) return;

  try {
    const message: WSMessage = JSON.parse(data);

    // 处理 ping
    if (message.type === 'ping') {
      wsManager.send(connectionId, { type: 'pong' });
      return;
    }

    // 处理聊天完成请求
    if (message.type === 'chat.completion') {
      const request = message.payload as ChatCompletionRequest;
      await handleChatCompletion(connectionId, request);
      return;
    }

    // 未知消息类型
    wsManager.send(connectionId, {
      type: 'error',
      error: {
        message: `Unknown message type: ${message.type}`,
        type: 'invalid_request_error',
        code: 'unknown_message_type',
      },
    });

  } catch (e) {
    writeLog('warn', '[WebSocket] Failed to parse message', {
      connection_id: connectionId,
      error: e instanceof Error ? e.message : String(e),
    });

    wsManager.send(connectionId, {
      type: 'error',
      error: {
        message: 'Invalid JSON message',
        type: 'invalid_request_error',
        code: 'invalid_json',
      },
    });
  }
}

/**
 * 处理聊天完成请求（流式）
 */
async function handleChatCompletion(connectionId: string, request: ChatCompletionRequest): Promise<void> {
  const conn = wsManager.getConnection(connectionId);
  if (!conn) return;

  try {
    // 解析模型别名
    request.model = resolveModelAlias(request.model || conn.model);

    // 虚拟密钥策略检查：允许的模型列表（与 HTTP 路径一致）
    if (conn.key_allowed_models && conn.key_allowed_models.length > 0 && !conn.key_allowed_models.includes(request.model)) {
      wsManager.send(connectionId, {
        type: 'error',
        error: {
          message: `Model '${request.model}' is not allowed by this API key. Allowed: ${conn.key_allowed_models.join(', ')}`,
          type: 'invalid_request_error',
          code: 'model_not_allowed',
        },
      });
      return;
    }

    // 虚拟密钥策略检查：月度预算
    if (conn.key_monthly_budget !== undefined && conn.key_hash) {
      const budgetCheck = checkKeyQuota(conn.key_hash, conn.key_monthly_budget);
      if (!budgetCheck.allowed) {
        wsManager.send(connectionId, {
          type: 'error',
          error: {
            message: budgetCheck.reason || 'API key monthly budget exceeded',
            type: 'rate_limit_error',
            code: 'budget_exceeded',
          },
        });
        return;
      }
    }

    // 虚拟密钥策略：clamp max_tokens
    if (conn.key_max_tokens !== undefined && (request.max_tokens === undefined || request.max_tokens > conn.key_max_tokens)) {
      request.max_tokens = conn.key_max_tokens;
    }

    // 创建轻量 mock Context 供插件使用
    const mockCtx = {
      get: (key: string) => {
        if (key === 'tenant_id') return conn.tenant_id;
        if (key === 'request_id') return connectionId;
        return undefined;
      },
      set: () => {},
      req: { header: () => undefined },
    } as unknown as Context;

    // 1. 运行 Guardrail 插件
    const guardrailResult = await runGuardrailPlugins(mockCtx, request);
    if (!guardrailResult.allowed) {
      wsManager.send(connectionId, {
        type: 'error',
        error: {
          message: guardrailResult.reasons?.join('; ') || 'Request blocked by guardrail',
          type: 'invalid_request_error',
          code: 'guardrail_blocked',
        },
      });
      return;
    }

    // 2. 运行请求插件（转换/增强请求）
    let processedReq: ChatCompletionRequest;
    try {
      processedReq = await runRequestPlugins(mockCtx, request);
    } catch (pluginErr) {
      writeLog('warn', '[WebSocket] Request plugin failed, using original request', {
        error: pluginErr instanceof Error ? pluginErr.message : String(pluginErr),
      });
      processedReq = request;
    }

    const model = processedReq.model;

    // 3. 智能路由决策（WebSocket 暂不支持策略选择，使用默认路由）
    let providerName: string | undefined;
    const strategy = (processedReq as unknown as Record<string, unknown>).routing_strategy as RouterStrategy | undefined;
    if (strategy && ['cost', 'latency', 'quality', 'balance'].includes(strategy)) {
      const decision = smartRoute(processedReq, strategy);
      providerName = decision.provider;
      writeLog('info', '[WebSocket] SmartRouter selected provider', {
        model,
        provider: providerName,
        strategy,
        reason: decision.reason,
      });
    } else {
      providerName = getProviderForModel(model);
    }

    if (!providerName) {
      wsManager.send(connectionId, {
        type: 'error',
        error: {
          message: `No provider configured for model: ${model}`,
          type: 'invalid_request_error',
          code: 'no_provider_for_model',
        },
      });
      return;
    }

    // 4. 配额检查
    const quotaCheck = checkQuota(conn.tenant_id);
    if (!quotaCheck.allowed) {
      wsManager.send(connectionId, {
        type: 'error',
        error: {
          message: quotaCheck.reason || 'Quota exceeded',
          type: 'rate_limit_error',
          code: 'quota_exceeded',
        },
      });
      return;
    }

    // 创建 AbortController 用于取消请求
    const abortController = new AbortController();
    wsManager.setAbortController(connectionId, abortController);

    // 强制流式
    request.stream = true;

    const stream = await chatCompleteStream(providerName, request, { signal: abortController.signal });

    // 流式转发到 WebSocket
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;
    let accumulatedContent = '';
    let wsClientDisconnected = false;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // 客户端断连检查：如果连接已被移除，停止处理并跳过费用记录
        if (!wsManager.getConnection(connectionId)) {
          wsClientDisconnected = true;
          reader.cancel().catch(() => {});
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === ': OPENROUTER PROCESSING') continue;
          if (trimmed === 'data: [DONE]') {
            // 发送完成信号
            wsManager.send(connectionId, {
              type: 'chat.completion.chunk',
              id: connectionId,
              payload: '[DONE]',
            });
            continue;
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const chunk = JSON.parse(jsonStr);
              // 捕获 usage 信息（部分 provider 在最后一个 chunk 前发送）
              if (chunk.usage) {
                usage = chunk.usage;
              }
              // 累加 delta content（供本地 token 计数降级使用）
              if (chunk.choices && Array.isArray(chunk.choices)) {
                for (const choice of chunk.choices as Array<{ delta?: { content?: string; role?: string } }>) {
                  accumulatedContent = accumulateStreamContent(accumulatedContent, choice.delta);
                }
              }
              wsManager.send(connectionId, {
                type: 'chat.completion.chunk',
                id: connectionId,
                payload: chunk,
              });
            } catch (e) {
              // 忽略解析错误的 chunk
              writeLog('debug', '[WebSocket] Failed to parse SSE chunk', { error: e });
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
      wsManager.setAbortController(connectionId, null);

      // 客户端未断连时，记录费用
      if (!wsClientDisconnected) {
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;

        if (usage) {
          // Provider 返回了 usage，优先使用
          promptTokens = usage.prompt_tokens || 0;
          completionTokens = usage.completion_tokens || 0;
          totalTokens = usage.total_tokens || promptTokens + completionTokens;
        } else {
          // Provider 未返回 usage，使用本地计数
          promptTokens = await countPromptTokens(processedReq.messages as ChatMessage[], model);
          completionTokens = await countCompletionTokens(accumulatedContent, model);
          totalTokens = promptTokens + completionTokens;
        }

        const config = getConfig();
        const pricing = config.pricing?.[model];
        let cost = 0;
        if (pricing) {
          cost = (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
        }
        recordUsage(conn.tenant_id, totalTokens, cost);
      }
    }

  } catch (e) {
    writeLog('error', '[WebSocket] Chat completion failed', {
      connection_id: connectionId,
      error: e instanceof Error ? e.message : String(e),
    });

    wsManager.send(connectionId, {
      type: 'error',
      error: {
        message: e instanceof Error ? e.message : 'Unknown error',
        type: 'provider_error',
        code: 'stream_failed',
      },
    });
  }
}

/**
 * WebSocket 中间件 - 仅认证和升级
 */
export async function wsAuthMiddleware(_c: Context, next: Next): Promise<void> {
  // 认证由全局 authMiddleware 处理
  // 这里只需要确认升级请求
  await next();
}

/**
 * 获取 WebSocket 统计
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
 * 添加连接（向后兼容）
 */
export function addConnection(tenantId: string, model: string): string {
  // 注意：这个函数只创建元数据，不关联实际的 WebSocket
  // 真实场景应该使用 handleWSConnection
  const dummyWS = {} as WebSocket;
  return wsManager.addConnection(dummyWS, tenantId, model);
}

/**
 * 移除连接（向后兼容）
 */
export function removeConnection(id: string): boolean {
  return wsManager.removeConnection(id);
}

/**
 * 广播请求完成事件
 */
export function broadcastRequestComplete(data: {
  request_id: string;
  tenant_id: string;
  model: string;
  provider: string;
  duration_ms: number;
  total_tokens: number;
  status: 'success' | 'error';
  error?: string;
}): void {
  wsManager.broadcastRequestComplete(data);
}

/**
 * 获取连接（向后兼容）
 */
export function getConnection(id: string): Omit<WSConnection, 'ws' | 'abort_controller'> | null {
  const conn = wsManager.getConnection(id);
  if (!conn) return null;
  // 不暴露内部的 ws 对象
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ws, abort_controller, ...rest } = conn;
  return rest;
}

/**
 * 获取租户的所有连接（向后兼容）
 */
export function getConnectionsByTenant(tenantId: string): Omit<WSConnection, 'ws' | 'abort_controller'>[] {
  return wsManager
    .getConnectionsByTenant(tenantId)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ ws, abort_controller, ...rest }) => rest);
}

/**
 * 重置所有连接
 */
export function resetWebSocketConnections(): void {
  wsManager.clear();
}

// 导出类型（上面已经导出 WSConnection）
export type { WebSocketManager };
