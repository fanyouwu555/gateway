/**
 * 插件动态加载器
 * 使用 Node.js vm 模块在沙箱中执行外部 JS 插件代码
 */
import { runInNewContext } from 'node:vm';
import type { Context } from 'hono';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../types';
import { writeLog } from '../utils/logger';
import type {
  IPlugin,
  GuardrailPlugin,
  RequestPlugin,
  ResponsePlugin,
  TransformPlugin,
} from './index';

/**
 * 沙箱中允许的全局对象
 */
const ALLOWED_GLOBALS = {
  console: {
    log: (...args: unknown[]) => writeLog('info', 'Plugin log', { args: args.map((a) => String(a)) }),
    error: (...args: unknown[]) => writeLog('error', 'Plugin error', { args: args.map((a) => String(a)) }),
    warn: (...args: unknown[]) => writeLog('warn', 'Plugin warn', { args: args.map((a) => String(a)) }),
  },
  JSON,
  Math,
  Date,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  Promise,
  Set,
  Map,
  Symbol,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
};

/**
 * 插件加载结果
 */
export interface PluginLoadResult {
  success: boolean;
  plugin?: IPlugin;
  error?: string;
}

/**
 * 验证插件配置结构
 */
function validatePluginConfig(config: unknown): { valid: boolean; error?: string } {
  if (typeof config !== 'object' || config === null) {
    return { valid: false, error: 'Plugin config must be an object' };
  }
  const c = config as Record<string, unknown>;
  if (typeof c.id !== 'string' || !c.id) {
    return { valid: false, error: 'Plugin config.id is required and must be a non-empty string' };
  }
  if (typeof c.name !== 'string' || !c.name) {
    return { valid: false, error: 'Plugin config.name is required and must be a non-empty string' };
  }
  if (typeof c.type !== 'string' || !['request', 'response', 'transform', 'guardrail', 'custom'].includes(c.type)) {
    return { valid: false, error: 'Plugin config.type must be one of: request, response, transform, guardrail, custom' };
  }
  if (typeof c.enabled !== 'boolean') {
    return { valid: false, error: 'Plugin config.enabled is required and must be a boolean' };
  }
  if (typeof c.priority !== 'number') {
    return { valid: false, error: 'Plugin config.priority is required and must be a number' };
  }
  return { valid: true };
}

/**
 * 将沙箱中的函数包装为可安全调用的异步函数
 */
function wrapSandboxFunction<T extends unknown[], R>(
  fn: unknown,
  name: string
): (...args: T) => Promise<R> {
  if (typeof fn !== 'function') {
    throw new Error(`Plugin handler "${name}" must be a function`);
  }
  return async (...args: T): Promise<R> => {
    try {
      const result = await (fn as (...a: T) => R | Promise<R>)(...args);
      return result;
    } catch (error) {
      writeLog('error', 'Plugin handler error', { handler: name, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}

/**
 * 从沙箱导出构建 IPlugin 实例
 */
function buildPluginFromSandbox(exports: unknown): PluginLoadResult {
  if (typeof exports !== 'object' || exports === null) {
    return { success: false, error: 'Plugin must export an object' };
  }

  const mod = exports as Record<string, unknown>;
  const configValidation = validatePluginConfig(mod.config);
  if (!configValidation.valid) {
    return { success: false, error: configValidation.error };
  }

  const config = mod.config as {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    priority: number;
    settings?: Record<string, unknown>;
  };

  switch (config.type) {
    case 'guardrail': {
      if (typeof mod.check !== 'function') {
        return { success: false, error: 'Guardrail plugin must export a "check" function' };
      }
      const plugin: GuardrailPlugin = {
        config: { ...config, type: 'guardrail' },
        check: wrapSandboxFunction<[Context, unknown], { allowed: boolean; reason?: string }>(
          mod.check,
          'check'
        ),
      };
      return { success: true, plugin };
    }
    case 'request': {
      if (typeof mod.onRequest !== 'function') {
        return { success: false, error: 'Request plugin must export an "onRequest" function' };
      }
      const plugin: RequestPlugin = {
        config: { ...config, type: 'request' },
        onRequest: wrapSandboxFunction<[Context, ChatCompletionRequest], ChatCompletionRequest | null>(
          mod.onRequest,
          'onRequest'
        ),
      };
      return { success: true, plugin };
    }
    case 'response': {
      if (typeof mod.onResponse !== 'function') {
        return { success: false, error: 'Response plugin must export an "onResponse" function' };
      }
      const plugin: ResponsePlugin = {
        config: { ...config, type: 'response' },
        onResponse: wrapSandboxFunction<[Context, ChatCompletionResponse], ChatCompletionResponse | null>(
          mod.onResponse,
          'onResponse'
        ),
      };
      return { success: true, plugin };
    }
    case 'transform': {
      if (typeof mod.transform !== 'function') {
        return { success: false, error: 'Transform plugin must export a "transform" function' };
      }
      const plugin: TransformPlugin = {
        config: { ...config, type: 'transform' },
        transform: wrapSandboxFunction<[Context, unknown], unknown>(
          mod.transform,
          'transform'
        ),
      };
      return { success: true, plugin };
    }
    default:
      return { success: false, error: `Unsupported plugin type: ${config.type}` };
  }
}

/**
 * 在沙箱中加载插件代码
 *
 * ⚠️ SECURITY WARNING ⚠️
 * This function executes arbitrary JavaScript code in a vm.runInNewContext sandbox.
 * While the sandbox restricts access to Node.js builtins (require, process, fs, etc.)
 * and only exposes a whitelist of safe globals, it is NOT a fully secure isolation boundary.
 *
 * - ONLY call this function from admin-protected endpoints (/v1/plugins/*)
 * - NEVER allow non-admin users to submit or upload plugin code
 * - Plugin code execution is admin-only functionality by design
 * - Consider running plugin code in a separate process or WASM for stronger isolation
 *
 * @param code 插件 JS 代码字符串
 */
export function loadPluginInSandbox(code: string): PluginLoadResult {
  const sandbox = {
    ...ALLOWED_GLOBALS,
    exports: {},
    module: { exports: {} as Record<string, unknown> },
  };

  try {
    const wrappedCode = `
      (function(exports, module) {
        "use strict";
        ${code}
        if (typeof module.exports !== 'undefined') {
          exports = module.exports;
        }
      })(exports, module)
    `;

    runInNewContext(wrappedCode, sandbox, {
      timeout: 5000,
      displayErrors: true,
    });

    const exports = sandbox.module.exports || sandbox.exports;
    return buildPluginFromSandbox(exports);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 序列化插件为可持久化的配置
 */
export function serializePlugin(plugin: IPlugin): string {
  return JSON.stringify({
    config: plugin.config,
  });
}
