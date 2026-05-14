/**
 * AI Gateway 入口文件
 * HTTP 服务器生命周期管理（启动、优雅关闭、初始化）
 * 应用配置见 src/app.ts
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './app';
import { getConfig } from './config';
import { initProviders } from './providers/registry';
import { initPricing } from './services/metrics';
import { initCache } from './services/cache';
import { initSessionStore } from './services/history';
import { initRateLimitCleanInterval } from './middleware/ratelimit';
import { createSensitiveWordFilterPlugin, registerPlugin } from './plugins';
import { writeLog } from './middleware/logger';

// 创建 Hono 应用实例
const app = createApp();

/**
 * 启动 HTTP 服务器
 * 使用原生 node:http 而非 @hono/node-server，以支持跨平台 CORS 预检
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

  // 所有 HTTP 请求通过 Hono 的 fetch 处理
  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    // 处理 CORS 预检请求
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-model');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

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
