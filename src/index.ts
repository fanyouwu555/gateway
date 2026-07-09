/**
 * AI Gateway 入口文件
 * HTTP 服务器生命周期管理（启动、优雅关闭、初始化）
 * 应用配置见 src/app.ts
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'hono';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { createApp } from './app';
import { getConfig } from './config';
import { initProviders } from './providers/registry';
import { initCache } from './services/cache';
import { initSemanticCache } from './services/semantic-cache';
import { initRateLimitCleanInterval } from './middleware/ratelimit';
import { createSensitiveWordFilterPlugin, registerPlugin } from './plugins';
import { createPiiPlugin, createPiiBlockGuardrail, createPromptInjectionGuardrail } from './plugins/guardrails';
import { loadPluginInSandbox } from './plugins/loader';
import { getPluginStore } from './services/plugin-store';
import { writeLog } from './utils/logger';
import { initWebSocket, handleWSConnection, resetWebSocketConnections } from './middleware/websocket';
import { initQuotaStore, flushQuotaStore } from './services/quota';
import { initTenantStore, flushTenantStore } from './services/tenant';
import { initTenantTemplateStore, flushTenantTemplateStore } from './services/tenant-template';
import { initWalletStore, flushWalletStore } from './services/wallet';
import { initBillingCostTracker, flushBillingCostTracker } from './services/billing';
import { initMetricsStore } from './services/metrics';
import { startAlertEngine } from './services/alert';
import { initConversationLogService } from './services/conversation-log';
import { initRequestLogStore } from './services/request-log';
import { failoverManager } from './services/failover';
import { initTracing } from './utils/tracing';
import { initStorageFactory } from './stores/factory';
import type { StorageType } from './stores/interface';
import { runStartup } from './utils/startup';
import { shutdownRegistry } from './utils/shutdown';

async function loadPersistedPlugins(): Promise<void> {
  try {
    const store = getPluginStore();
    const ids = await store.list();
    for (const id of ids) {
      const code = await store.load(id);
      if (!code) continue;
      const result = loadPluginInSandbox(code);
      if (result.success && result.plugin) {
        registerPlugin(result.plugin);
        writeLog('info', 'Restored persisted plugin', { id });
      } else {
        writeLog('warn', 'Failed to restore persisted plugin', { id, error: result.error });
      }
    }
  } catch (err) {
    writeLog('error', 'Failed to load persisted plugins', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function registerBuiltinPlugins(): void {
  const sensitiveWords = process.env.SENSITIVE_WORDS
    ? process.env.SENSITIVE_WORDS.split(',').filter(Boolean)
    : [];
  if (sensitiveWords.length > 0) {
    const sensitiveFilter = createSensitiveWordFilterPlugin(sensitiveWords);
    registerPlugin(sensitiveFilter);
  }

  const piiPlugin = createPiiPlugin();
  registerPlugin(piiPlugin);

  const piiBlockGuardrail = createPiiBlockGuardrail();
  if (piiBlockGuardrail.config.enabled) {
    registerPlugin(piiBlockGuardrail);
  }

  const injectionGuardrail = createPromptInjectionGuardrail();
  registerPlugin(injectionGuardrail);
}

// 创建 Hono 应用实例
const app = createApp();

/**
 * 启动 HTTP 服务器
 * 使用原生 node:http 代理到 Hono fetch
 * CORS 由 Hono cors() 中间件处理（src/app.ts）
 */
async function startServer() {
  const config = getConfig();

  // 注册关闭时的 flush 处理器
  shutdownRegistry.register('quota', flushQuotaStore);
  shutdownRegistry.register('tenant', flushTenantStore);
  shutdownRegistry.register('tenant-template', flushTenantTemplateStore);
  shutdownRegistry.register('wallet', flushWalletStore);
  shutdownRegistry.register('billing', flushBillingCostTracker);

  await runStartup([
    {
      name: 'core',
      critical: true,
      inits: [
        async () => {
          const storageType = (process.env.STORAGE_TYPE || 'memory') as StorageType;
          initStorageFactory({ type: storageType });
          if (storageType === 'memory') {
            writeLog('warn', 'Running with IN-MEMORY storage — all data will be lost on restart. Set STORAGE_TYPE=redis for persistence.');
          }
        },
        async () => initProviders(),
        async () => initTracing(),
      ],
    },
    {
      name: 'storage',
      critical: true,
      inits: [
        async () => {
          const cacheStore = initCache(config.cache);
          await cacheStore.initStorage();
        },
        async () => initSemanticCache(config.semantic_cache),
        async () => failoverManager.init(),
      ],
    },
    {
      name: 'services',
      critical: true,
      inits: [
        async () => initConversationLogService(),
        async () => initRequestLogStore(),
        async () => initQuotaStore(),
        async () => initTenantStore(),
        async () => initTenantTemplateStore(),
        async () => initWalletStore(),
        async () => initBillingCostTracker(),
        async () => initMetricsStore(),
      ],
    },
    {
      name: 'plugins',
      critical: false,
      inits: [
        async () => loadPersistedPlugins(),
        async () => registerBuiltinPlugins(),
      ],
    },
    {
      name: 'runtime',
      critical: true,
      inits: [
        async () => startAlertEngine(),
        async () => initRateLimitCleanInterval(config.rate_limit_clean_interval),
        async () => initWebSocket(),
      ],
    },
  ]);

  writeLog('info', 'Alert engine started');

  // 定期 flush 配额数据到 Redis（每 60 秒）
  setInterval(() => {
    flushQuotaStore().catch(() => {});
    flushTenantStore().catch(() => {});
    flushTenantTemplateStore().catch(() => {});
    flushWalletStore().catch(() => {});
    flushBillingCostTracker().catch(() => {});
  }, 60000).unref();

  const server = createServer();

  // 创建 WebSocket 服务器
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      const token = Array.from(protocols).find((p) => p.startsWith('gateway-token-'));
      return token || false;
    },
  });

  // 处理 WebSocket 升级
  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    const host = req.headers.host || `localhost:${config.port}`;
    const fullUrl = `http://${host}${req.url}`;

    // 只处理 /v1/ws 路径的升级请求
    if (!req.url?.startsWith('/v1/ws')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // 通过 Hono 运行认证中间件
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    try {
      const mockRequest = new Request(fullUrl, {
        method: 'GET',
        headers,
      });

      const response = await app.fetch(mockRequest);

      // 检查认证是否通过（状态码 401 表示失败）
      if (response.status === 401) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // 从响应中提取 tenant_id（通过一个临时的 header 传递）
      const tenantId = response.headers.get('x-tenant-id') || 'default';

      // 认证通过，升级连接
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        wss.emit('connection', ws, { tenantId, path: req.url });
      });
    } catch (err) {
      writeLog('error', '[WebSocket] Upgrade failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  // WebSocket 连接建立后处理
  wss.on('connection', (ws, request: { tenantId: string; path: string }) => {
    // 从路径中提取 model 参数
    const url = new URL(request.path, 'http://localhost');
    const model = url.searchParams.get('model') || getConfig().default_model || 'gpt-4o-mini';

    // 创建一个模拟的 Context 对象
    const mockContext = {
      get: (key: string) => key === 'tenant_id' ? request.tenantId : undefined,
      req: {
        query: (key: string) => key === 'model' ? model : undefined,
      },
    } as unknown as Context;

    handleWSConnection(ws, mockContext);
  });

  // 所有 HTTP 请求通过 Hono 的 fetch 处理
  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    // 构建完整 URL
    const host = req.headers.host || `localhost:${config.port}`;
    const fullUrl = `http://${host}${req.url}`;

    // 转换 headers 为普通对象
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    try {
      const requestOptions: RequestInit = { method: req.method, headers };

      // 对于有 body 的请求，读取 body（带 10MB 大小限制）
      if (req.method && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
        const body = await new Promise<string>((resolve, reject) => {
          let data = '';
          let size = 0;
          req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
              reject(new Error('Request body too large'));
              return;
            }
            data += chunk;
          });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });
        requestOptions.body = body;
      }

      const mockRequest = new Request(fullUrl, requestOptions);
      const response = await app.fetch(mockRequest);

      // 设置响应
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      const body = await response.text();
      res.end(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg === 'Request body too large') {
        res.writeHead(413);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'Request body too large', type: 'invalid_request_error', code: 'body_too_large' } }));
        return;
      }
      writeLog('error', 'Request handling error', { error: msg });
      res.writeHead(500);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Internal server error', type: 'internal_error', code: 'internal_error' } }));
    }
  });

  server.on('error', (err: Error) => {
    writeLog('error', 'Server error', { error: err.message });
  });

  // 启动服务器
  server.listen(config.port, config.host, () => {
    writeLog('info', 'AI Gateway Server started', {
      port: config.port,
      host: config.host,
      log_level: config.log_level,
      auth: config.auth.enabled,
    });
  });

  // 优雅关闭
  const handleShutdown = (signal: string) => {
    writeLog('info', 'Server shutting down', { signal });
    // 清理所有 WebSocket 连接
    resetWebSocketConnections();
    // Flush 待写入 Redis 的数据，避免优雅关闭时丢失
    shutdownRegistry.flushAll().then(() => {
      server.close(() => {
        writeLog('info', 'HTTP server closed');
        process.exit(0);
      });
    });
    // 超时强制退出
    setTimeout(() => {
      writeLog('error', 'Forced shutdown after timeout');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

startServer().catch((err) => {
  writeLog('error', 'Failed to start server', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

export { app };
