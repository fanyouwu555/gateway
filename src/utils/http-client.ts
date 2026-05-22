/**
 * HTTP 客户端封装
 * 使用 undici Agent 实现连接池和 Keep-Alive
 */
import { Agent, fetch as undiciFetch } from 'undici';
import { getEnv } from '.';

const keepAlive = getEnv('HTTP_KEEP_ALIVE', 'true') !== 'false';
const keepAliveTimeout = parseInt(getEnv('HTTP_KEEP_ALIVE_TIMEOUT', '60000'), 10);

/**
 * 共享 undici Agent
 * 支持连接池、Keep-Alive
 */
export const sharedAgent = new Agent({
  connect: {
    keepAlive,
    keepAliveInitialDelay: keepAliveTimeout,
  },
});

/**
 * 使用共享 Agent 的 fetch 封装
 * 自动注入 Connection: keep-alive
 */
export async function fetchWithAgent(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers || {});
  if (keepAlive && !headers.has('Connection')) {
    headers.set('Connection', 'keep-alive');
  }

  return undiciFetch(input as unknown as Parameters<typeof undiciFetch>[0], {
    ...(init as Record<string, unknown>),
    headers,
    dispatcher: sharedAgent,
  } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
