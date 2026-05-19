/**
 * AI Gateway 入口文件
 * HTTP 服务器生命周期管理（启动、优雅关闭、初始化）
 * 应用配置见 src/app.ts
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'hono';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { createApp } from './app';
import { getConfig } from './config';
import { initProviders } from './providers/registry';
import { initPricing } from './services/metrics';
import { initCache } from './services/cache';
import { initSessionStore } from './services/history';
import { initRateLimitCleanInterval } from './middleware/ratelimit';
import { createSensitiveWordFilterPlugin, registerPlugin } from './plugins';
import { writeLog } from './utils/logger';
import { initWebSocket, handleWSConnection } from './middleware/websocket';

// 创建 Hono 应用实例
const app = createApp();

/**
 * 启动 HTTP 服务器
 * 使用原生 node:http 代理到 Hono fetch
 * CORS 由 Hono cors() 中间件处理（src/app.ts）
 */
async function startServer() {
  // 初始化 Providers
  initProviders();

  // 注册内置插件
  const sensitiveFilter = createSensitiveWordFilterPlugin(['xxx', 'test-bad-word']);
  registerPlugin(sensitiveFilter);

  // 获取配置
  const config = getConfig();

  // 初始化 Token 定价（从配置文件读取）
  initPricing(config.pricing);

  // 初始化缓存配置
  initCache(config.cache);

  // 初始化会话历史配置
  initSessionStore(config.session);

  // 初始化限流清理间隔
  initRateLimitCleanInterval(config.rate_limit_clean_interval);

  const server = createServer();

  // 初始化 WebSocket 管理器
  initWebSocket();

  // 创建 WebSocket 服务器
  const wss = new WebSocketServer({ noServer: true });

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

      // 对于有 body 的请求，读取 body
      if (req.method && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const body = await new Promise<string>((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => { data += chunk; });
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
      writeLog('error', 'Request handling error', { error: msg });
      res.writeHead(500);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Internal server error', type: 'internal_error' } }));
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
    server.close(() => {
      writeLog('info', 'HTTP server closed');
      process.exit(0);
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
