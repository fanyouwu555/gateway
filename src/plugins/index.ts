/**
 * 插件系统基础
 * 支持请求/响应拦截、转换、增强
 */
import type { Context } from 'hono';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../types';
import { writeLog } from '../utils/logger';

/**
 * 插件类型
 */
type PluginType = 'request' | 'response' | 'transform' | 'guardrail' | 'custom';

/**
 * 插件生命周期
 */

/**
 * 插件配置
 */
interface PluginConfig {
  id: string;
  name: string;
  type: PluginType;
  enabled: boolean;
  priority: number;
  settings?: Record<string, unknown>;
}

/**
 * 通用插件接口
 */
interface IPlugin {
  config: PluginConfig;
}

/**
 * 请求拦截器插件
 */
interface RequestPlugin extends IPlugin {
  onRequest: (c: Context, request: ChatCompletionRequest) => Promise<ChatCompletionRequest | null>;
}

/**
 * 响应拦截器插件
 */
interface ResponsePlugin extends IPlugin {
  onResponse: (c: Context, response: ChatCompletionResponse) => Promise<ChatCompletionResponse | null>;
}

/**
 * 转换插件
 */
interface TransformPlugin extends IPlugin {
  transform: (c: Context, data: unknown) => Promise<unknown>;
}

/**
 * Guardrail 插件
 */
interface GuardrailPlugin extends IPlugin {
  check: (c: Context, data: unknown) => Promise<{ allowed: boolean; reason?: string }>;
}

/**
 * 插件管理器
 */
class PluginManager {
  private plugins: IPlugin[] = [];
  private requestPlugins: RequestPlugin[] = [];
  private responsePlugins: ResponsePlugin[] = [];
  private transformPlugins: TransformPlugin[] = [];
  private guardrailPlugins: GuardrailPlugin[] = [];

  /**
   * 注册插件
   */
  register(plugin: IPlugin): void {
    this.plugins.push(plugin);

    switch (plugin.config.type) {
      case 'request':
        this.requestPlugins.push(plugin as RequestPlugin);
        break;
      case 'response':
        this.responsePlugins.push(plugin as ResponsePlugin);
        break;
      case 'transform':
        this.transformPlugins.push(plugin as TransformPlugin);
        break;
      case 'guardrail':
        this.guardrailPlugins.push(plugin as GuardrailPlugin);
        break;
    }

    // 按优先级排序
    this.sortPlugins();
  }

  /**
   * 排序
   */
  private sortPlugins(): void {
    this.requestPlugins.sort((a, b) => b.config.priority - a.config.priority);
    this.responsePlugins.sort((a, b) => b.config.priority - a.config.priority);
    this.transformPlugins.sort((a, b) => b.config.priority - a.config.priority);
    this.guardrailPlugins.sort((a, b) => b.config.priority - a.config.priority);
  }

  /**
   * 移除插件
   */
  unregister(pluginId: string): boolean {
    const initialLength = this.plugins.length;
    this.plugins = this.plugins.filter((p) => p.config.id !== pluginId);
    this.requestPlugins = this.requestPlugins.filter((p) => p.config.id !== pluginId);
    this.responsePlugins = this.responsePlugins.filter((p) => p.config.id !== pluginId);
    this.transformPlugins = this.transformPlugins.filter((p) => p.config.id !== pluginId);
    this.guardrailPlugins = this.guardrailPlugins.filter((p) => p.config.id !== pluginId);
    return this.plugins.length < initialLength;
  }

  /**
   * 执行请求拦截
   */
  async runRequestPlugins(c: Context, request: ChatCompletionRequest): Promise<ChatCompletionRequest> {
    let result = request;

    for (const plugin of this.requestPlugins) {
      if (!plugin.config.enabled) continue;

      try {
        const modified = await plugin.onRequest(c, result);
        if (modified !== null) {
          result = modified;
        }
      } catch (error) {
        writeLog('error', 'Request plugin error', { plugin_id: plugin.config.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return result;
  }

  /**
   * 执行响应拦截
   */
  async runResponsePlugins(c: Context, response: ChatCompletionResponse): Promise<ChatCompletionResponse> {
    let result = response;

    for (const plugin of this.responsePlugins) {
      if (!plugin.config.enabled) continue;

      try {
        const modified = await plugin.onResponse(c, result);
        if (modified !== null) {
          result = modified;
        }
      } catch (error) {
        writeLog('error', 'Response plugin error', { plugin_id: plugin.config.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return result;
  }

  /**
   * 执行Guardrail检查
   */
  async runGuardrailPlugins(c: Context, data: unknown): Promise<{ allowed: boolean; reasons: string[] }> {
    const reasons: string[] = [];

    for (const plugin of this.guardrailPlugins) {
      if (!plugin.config.enabled) continue;

      try {
        const result = await plugin.check(c, data);
        if (!result.allowed && result.reason) {
          reasons.push(`[${plugin.config.name}] ${result.reason}`);
        }
      } catch (error) {
        writeLog('error', 'Guardrail plugin error', { plugin_id: plugin.config.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      allowed: reasons.length === 0,
      reasons,
    };
  }

  /**
   * 执行转换
   */
  async runTransformPlugins(c: Context, data: unknown): Promise<unknown> {
    let result = data;

    for (const plugin of this.transformPlugins) {
      if (!plugin.config.enabled) continue;

      try {
        result = await plugin.transform(c, result);
      } catch (error) {
        writeLog('error', 'Transform plugin error', { plugin_id: plugin.config.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return result;
  }

  /**
   * 获取所有插件
   */
  list(): PluginConfig[] {
    return this.plugins.map((p) => p.config);
  }

  /**
   * 获取指定类型插件
   */
  listByType(type: PluginType): PluginConfig[] {
    return this.plugins.filter((p) => p.config.type === type).map((p) => p.config);
  }

  /**
   * 启用/禁用插件
   */
  setEnabled(pluginId: string, enabled: boolean): boolean {
    const plugin = this.plugins.find((p) => p.config.id === pluginId);
    if (!plugin) return false;

    plugin.config.enabled = enabled;
    return true;
  }
}

// 单例
let pluginManager = new PluginManager();

/**
 * 重置插件管理器（用于测试隔离）
 */
export function resetPluginManager(): void {
  pluginManager = new PluginManager();
}

/**
 * 注册插件
 */
export function registerPlugin(plugin: IPlugin): void {
  pluginManager.register(plugin);
}

/**
 * 移除插件
 */
export function unregisterPlugin(pluginId: string): boolean {
  return pluginManager.unregister(pluginId);
}

/**
 * 执行请求拦截
 */
export async function runRequestPlugins(
  c: Context,
  request: ChatCompletionRequest
): Promise<ChatCompletionRequest> {
  return pluginManager.runRequestPlugins(c, request);
}

/**
 * 执行响应拦截
 */
export async function runResponsePlugins(
  c: Context,
  response: ChatCompletionResponse
): Promise<ChatCompletionResponse> {
  return pluginManager.runResponsePlugins(c, response);
}

/**
 * 执行Guardrail检查
 */
export async function runGuardrailPlugins(c: Context, data: unknown) {
  return pluginManager.runGuardrailPlugins(c, data);
}

/**
 * 列出所有插件
 */
export function listPlugins(): PluginConfig[] {
  return pluginManager.list();
}

/**
 * 启用/禁用插件
 */
export function setPluginEnabled(pluginId: string, enabled: boolean): boolean {
  return pluginManager.setEnabled(pluginId, enabled);
}

// ===== 内置插件 =====

/**
 * 敏感词过滤插件
 */
export function createSensitiveWordFilterPlugin(words: string[]): GuardrailPlugin {
  return {
    config: {
      id: 'sensitive-word-filter',
      name: 'Sensitive Word Filter',
      type: 'guardrail',
      enabled: true,
      priority: 100,
      settings: { words },
    },
    async check(_c: Context, data: unknown): Promise<{ allowed: boolean; reason?: string }> {
      if (typeof data !== 'object' || data === null) {
        return { allowed: true };
      }

      const request = data as { messages?: { content: string }[] };
      if (!request.messages) {
        return { allowed: true };
      }

      for (const msg of request.messages) {
        if (msg.content) {
          for (const word of words) {
            if (msg.content.toLowerCase().includes(word.toLowerCase())) {
              return { allowed: false, reason: `Sensitive word detected: ${word}` };
            }
          }
        }
      }

      return { allowed: true };
    },
  };
}

/**
 * 日志记录插件
 */
export function createLoggingPlugin(): TransformPlugin {
  return {
    config: {
      id: 'request-logger',
      name: 'Request Logger',
      type: 'transform',
      enabled: true,
      priority: 0,
    },
    async transform(c: Context, data: unknown): Promise<unknown> {
      const start = Date.now();
      const context = c as Context & { next?: () => Promise<void> };
      await context.next?.();
      const duration = Date.now() - start;
      writeLog('info', 'Plugin request processed', { duration_ms: duration });
      return data;
    },
  };
}