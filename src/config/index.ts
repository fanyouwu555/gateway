/**
 * 配置管理模块
 * 从环境变量和配置文件加载配置
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { IGatewayConfig, IProviderConfig } from '../types';
import { getEnv, ensureKeyHashed } from '../utils';
import { writeLog } from '../utils/logger';
import { getPricingService } from '../services/pricing';

function deepMergeConfig<T>(target: T, source: Partial<T>): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source as object)) {
    const sourceVal = (source as Record<string, unknown>)[key];
    const targetVal = (target as Record<string, unknown>)[key];
    if (
      sourceVal !== undefined &&
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== undefined &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMergeConfig(targetVal, sourceVal);
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result as T;
}

// 默认配置
const DEFAULT_CONFIG: IGatewayConfig = {
  port: parseInt(getEnv('PORT', '3000'), 10),
  host: getEnv('HOST', '0.0.0.0') || '0.0.0.0',
  log_level: (getEnv('LOG_LEVEL', 'info') || 'info') as IGatewayConfig['log_level'],
  providers: {},
  routing: [
    {
      name: 'default',
      rules: [
        { model: 'ark-code-latest', provider: 'volcano' },
        { model: 'kimi-for-coding', provider: 'kimi-code' },
      ],
    },
  ],
  auth: {
    enabled: true,
    api_keys: [],
  },
  rate_limit: {
    enabled: true,
    qps: 10,
    burst: 20,
  },
  failover: {
    enabled: false,
    failureThreshold: 3,
    successThreshold: 2,
    healthCheckInterval: 60000,
    healthCheckTimeout: 5000,
    healthCheckModel: 'ark-code-latest',
    chains: {},
    errorRateThreshold: 0.5,
    latencyThresholdMs: 30000,
  },
  loadBalance: {
    strategy: 'roundRobin',
  },
  cache: {
    enabled: true,
    ttl: 3600000,
    max_size: 1000,
  },
  semantic_cache: {
    enabled: false,
    threshold: 0.85,
    backend: 'memory',
    max_entries: 10000,
  },
  default_model: getEnv('DEFAULT_MODEL', 'ark-code-latest'),
  rate_limit_clean_interval: 60000,
  model_rate_limits: {},
  request_logging: { enabled: false, max_body_size: 4096, sample_rate: 1.0 },
  conversation_logging: { enabled: false, max_memory_sessions: 100, redis_ttl_days: 0, max_turns_per_session: 500 },
  pricing: {},
  max_retries: 3,
  dynamicProviders: [],
  model_equivalents: {},
  model_fallbacks: {},
  model_pools: {},
  model_capabilities: {},
};

/**
 * 加载配置文件
 */
function loadConfigFile(configPath?: string): Partial<IGatewayConfig> {
  const path = configPath || getEnv('CONFIG_PATH', './conf/default.json');

  try {
    const content = readFileSync(resolve(path), 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    writeLog('warn', 'Failed to load config file', { path, error: err instanceof Error ? err.message : String(err) });
    return {};
  }
}

/**
 * 从环境变量覆盖配置
 */
function overrideFromEnv(config: IGatewayConfig): IGatewayConfig {
  // 从环境变量读取API Keys (格式: API_KEYS=key1,key2)
  const apiKeysEnv = getEnv('API_KEYS');
  if (apiKeysEnv) {
    const keys = apiKeysEnv.split(',').filter(Boolean);
    config.auth.api_keys = keys.map((key, index) => ({
      key: key.trim(),
      tenant_id: 'default',
      name: `key-${index + 1}`,
      created_at: Date.now(),
    }));
  }

  // 从环境变量读取管理员 API Keys (格式: API_ADMIN_KEYS=adminkey1,adminkey2)
  // 这些 key 会在 auto-hash 步骤中自动哈希
  const adminKeysEnv = getEnv('API_ADMIN_KEYS');
  if (adminKeysEnv) {
    const keys = adminKeysEnv.split(',').filter(Boolean);
    for (const rawKey of keys) {
      const trimmed = rawKey.trim();
      (config.auth.api_keys || []).push({
        key: trimmed,
        tenant_id: 'admin',
        name: 'admin-key',
        created_at: Date.now(),
        is_admin: true,
      });
    }
  }

  // 从环境变量读取Provider配置
  const openaiKey = getEnv('OPENAI_API_KEY');
  if (openaiKey) {
    config.providers.openai = {
      provider: 'openai',
      base_url: getEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      api_key: openaiKey,
    };
  }

  // 从环境变量读取模型等效映射（JSON 格式）
  const modelEquivalentsEnv = getEnv('MODEL_EQUIVALENTS');
  if (modelEquivalentsEnv) {
    try {
      config.model_equivalents = JSON.parse(modelEquivalentsEnv);
    } catch {
      writeLog('warn', 'Failed to parse MODEL_EQUIVALENTS env var, skipping');
    }
  }

  // 从环境变量读取模型降级链配置（JSON 格式）
  const modelFallbacksEnv = getEnv('MODEL_FALLBACKS');
  if (modelFallbacksEnv) {
    try {
      config.model_fallbacks = JSON.parse(modelFallbacksEnv);
    } catch {
      writeLog('warn', 'Failed to parse MODEL_FALLBACKS env var, skipping');
    }
  }

  // 从环境变量读取模型能力池配置（JSON 格式）
  const modelPoolsEnv = getEnv('MODEL_POOLS');
  if (modelPoolsEnv) {
    try {
      config.model_pools = JSON.parse(modelPoolsEnv);
    } catch {
      writeLog('warn', 'Failed to parse MODEL_POOLS env var, skipping');
    }
  }

  const deepseekKey = getEnv('DEEPSEEK_API_KEY');
  if (deepseekKey) {
    config.providers.deepseek = {
      provider: 'deepseek',
      base_url: getEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
      api_key: deepseekKey,
    };
  }

  const anthropicKey = getEnv('ANTHROPIC_API_KEY');
  if (anthropicKey) {
    config.providers.anthropic = {
      provider: 'anthropic',
      base_url: getEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
      api_key: anthropicKey,
    };
  }

  // Mistral
  const mistralKey = getEnv('MISTRAL_API_KEY');
  if (mistralKey) {
    config.providers.mistral = {
      provider: 'mistral',
      base_url: getEnv('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1'),
      api_key: mistralKey,
    };
  }

  // Groq
  const groqKey = getEnv('GROQ_API_KEY');
  if (groqKey) {
    config.providers.groq = {
      provider: 'groq',
      base_url: getEnv('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
      api_key: groqKey,
    };
  }

  // Moonshot (Kimi)
  const moonshotKey = getEnv('MOONSHOT_API_KEY');
  if (moonshotKey) {
    config.providers.moonshot = {
      provider: 'moonshot',
      base_url: getEnv('MOONSHOT_BASE_URL', 'https://api.moonshot.cn/v1'),
      api_key: moonshotKey,
    };
  }

  // Google
  const googleKey = getEnv('GOOGLE_API_KEY');
  if (googleKey) {
    config.providers.google = {
      provider: 'google',
      base_url: getEnv('GOOGLE_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'),
      api_key: googleKey,
    };
  }

  // Volcano Engine (Coding Plan)
  const volcanoKey = getEnv('VOLCANO_API_KEY');
  if (volcanoKey) {
    config.providers.volcano = {
      provider: 'volcano',
      base_url: getEnv('VOLCANO_BASE_URL', 'https://ark.cn-beijing.volces.com/api/coding/v3'),
      api_key: volcanoKey,
    };
    // 通用 Chat 端点共用同一个 API Key
    config.providers['volcano-chat'] = {
      provider: 'volcano',
      base_url: getEnv('VOLCANO_CHAT_BASE_URL', 'https://ark.cn-beijing.volces.com/api/v3'),
      api_key: volcanoKey,
    };
  }

  // Kimi Code
  const kimiCodeKey = getEnv('KIMI_CODE_API_KEY');
  if (kimiCodeKey) {
    config.providers['kimi-code'] = {
      provider: 'kimi-code',
      base_url: getEnv('KIMI_CODE_BASE_URL', 'https://api.kimi.com/coding/v1'),
      api_key: kimiCodeKey,
    };
  }

  // Cohere
  const cohereKey = getEnv('COHERE_API_KEY');
  if (cohereKey) {
    config.providers.cohere = {
      provider: 'cohere',
      base_url: getEnv('COHERE_BASE_URL', 'https://api.cohere.com/v1'),
      api_key: cohereKey,
    };
  }

  // Together AI
  const togetherKey = getEnv('TOGETHER_API_KEY');
  if (togetherKey) {
    config.providers.together = {
      provider: 'together',
      base_url: getEnv('TOGETHER_BASE_URL', 'https://api.together.xyz/v1'),
      api_key: togetherKey,
    };
  }

  // Azure OpenAI
  const azureKey = getEnv('AZURE_OPENAI_API_KEY');
  if (azureKey) {
    const azureResource = getEnv('AZURE_OPENAI_RESOURCE', '');
    const azureDeployment = getEnv('AZURE_OPENAI_DEPLOYMENT', '');
    config.providers['azure-openai'] = {
      provider: 'azure-openai',
      base_url: `https://${azureResource}.openai.azure.com/openai/deployments/${azureDeployment}`,
      api_key: azureKey,
    };
  }

  // xAI
  const xaiKey = getEnv('XAI_API_KEY');
  if (xaiKey) {
    config.providers.xai = {
      provider: 'xai',
      base_url: getEnv('XAI_BASE_URL', 'https://api.x.ai/v1'),
      api_key: xaiKey,
    };
  }

  // Failover 配置
  const failoverEnabled = getEnv('FAILOVER_ENABLED');
  if (failoverEnabled !== undefined) {
    config.failover = {
      ...config.failover,
      enabled: failoverEnabled === 'true',
      failureThreshold: parseInt(getEnv('FAILOVER_FAILURE_THRESHOLD', '3') || '3', 10),
      successThreshold: parseInt(getEnv('FAILOVER_SUCCESS_THRESHOLD', '2') || '2', 10),
      healthCheckInterval: parseInt(getEnv('FAILOVER_HEALTH_CHECK_INTERVAL', '60000') || '60000', 10),
      healthCheckTimeout: parseInt(getEnv('FAILOVER_HEALTH_CHECK_TIMEOUT', '5000') || '5000', 10),
      healthCheckModel: getEnv('FAILOVER_HEALTH_CHECK_MODEL', 'gpt-4o-mini') || 'gpt-4o-mini',
    };
  }

  if (!config.failover) {
    config.failover = DEFAULT_CONFIG.failover!;
  }

  const failoverChainsEnv = getEnv('FAILOVER_CHAINS');
  if (failoverChainsEnv) {
    try {
      config.failover.chains = JSON.parse(failoverChainsEnv);
    } catch {
      writeLog('warn', 'Invalid FAILOVER_CHAINS JSON, ignoring');
    }
  }
  const errorRateThreshold = getEnv('FAILOVER_ERROR_RATE_THRESHOLD');
  if (errorRateThreshold !== undefined) {
    config.failover.errorRateThreshold = parseFloat(errorRateThreshold || '0.5');
  }
  const latencyThreshold = getEnv('FAILOVER_LATENCY_THRESHOLD_MS');
  if (latencyThreshold !== undefined) {
    config.failover.latencyThresholdMs = parseInt(latencyThreshold || '30000', 10);
  }

  // Semantic cache config
  const semanticCacheEnabled = getEnv('SEMANTIC_CACHE_ENABLED');
  if (semanticCacheEnabled !== undefined) {
    config.semantic_cache = {
      enabled: semanticCacheEnabled === 'true',
      threshold: parseFloat(getEnv('SEMANTIC_CACHE_THRESHOLD', '0.85') || '0.85'),
      backend: (getEnv('SEMANTIC_CACHE_BACKEND', 'memory') || 'memory') as 'memory' | 'redis_vector',
      max_entries: parseInt(getEnv('SEMANTIC_CACHE_MAX_ENTRIES', '10000') || '10000', 10),
    };
  }

  return config;
}

/**
 * 初始化配置
 */
export function initConfig(configPath?: string): IGatewayConfig {
  const fileConfig = loadConfigFile(configPath);
  let config = deepMergeConfig(DEFAULT_CONFIG, fileConfig);
  config = overrideFromEnv(config);

  // 验证必填字段
  if (!config.port || config.port <= 0) {
    throw new Error('Invalid port configuration');
  }

  // 自动哈希 API Key（将明文 key 转为 scrypt 哈希）
  if (config.auth.api_keys) {
    config.auth.api_keys = config.auth.api_keys.map((k) => ({
      ...k,
      key: ensureKeyHashed(k.key),
    }));
  }

  // 初始化 pricing service from config
  getPricingService().initialize(config.pricing);

  return config;
}

/**
 * 获取当前配置（单例）
 */
let _config: IGatewayConfig | null = null;

export function getConfig(): IGatewayConfig {
  if (!_config) {
    _config = initConfig();
  }
  return _config;
}

/**
 * 获取Provider配置
 */
export function getProviderConfig(providerName: string): IProviderConfig | undefined {
  const config = getConfig();
  return config.providers[providerName];
}

/**
 * 获取路由策略
 */
export function getRoutingStrategy(name: string = 'default') {
  const config = getConfig();
  return config.routing.find((s) => s.name === name);
}

/**
 * 根据模型名获取Provider
 */
export function getProviderForModel(model: string): string | undefined {
  const strategy = getRoutingStrategy();
  if (!strategy) return undefined;

  for (const rule of strategy.rules) {
    if (rule.model === model || model.startsWith(rule.model)) {
      return rule.provider;
    }
  }

  // 默认返回第一个规则的provider
  return strategy.rules[0]?.provider;
}

/**
 * 获取模型能力池
 */
export function getModelPool(poolName: string): import('../types').IModelPool | undefined {
  const config = getConfig();
  return config.model_pools?.[poolName];
}

/**
 * 检查模型名是否是模型池名称
 */
export function isModelPool(model: string): boolean {
  const config = getConfig();
  return !!config.model_pools && model in config.model_pools;
}

/**
 * 解析模型别名（支持递归解析，带循环检测）
 */
export function resolveModelAlias(alias: string): string {
  const config = getConfig();
  if (!config.model_aliases) return alias;

  const visited = new Set<string>();
  let current = alias;
  const maxDepth = 5;

  for (let i = 0; i < maxDepth; i++) {
    if (visited.has(current)) {
      writeLog('warn', 'Circular model alias detected', { alias, resolved: current });
      return alias; // 发现循环，返回原始别名
    }
    visited.add(current);

    const next = config.model_aliases[current];
    if (!next || next === current) {
      return current;
    }
    current = next;
  }

  writeLog('warn', 'Model alias resolution exceeded max depth', { alias, resolved: current });
  return current;
}

/**
 * 获取可用于调用的 API Keys
 */
export function getProviderApiKeys(config: IProviderConfig): string[] {
  if (config.api_keys && config.api_keys.length > 0) {
    return config.api_keys;
  }
  if (config.api_key) {
    return [config.api_key];
  }
  return [];
}

/**
 * 重新加载配置
 */
export function reloadConfig(configPath?: string): IGatewayConfig {
  _config = initConfig(configPath);
  return _config;
}

/**
 * 直接更新运行中的配置（不持久化到文件）
 * 用于管理 API 的运行时配置更新
 * 使用 deepMergeConfig 递归合并对象，数组采用替换策略
 */
export function setConfig(updates: Partial<IGatewayConfig>): IGatewayConfig {
  if (!_config) {
    _config = initConfig();
  }
  _config = deepMergeConfig(_config, updates);

  // 自动哈希新增的 API Key
  if (updates.auth?.api_keys) {
    _config.auth.api_keys = (_config.auth.api_keys || []).map((k) => ({
      ...k,
      key: ensureKeyHashed(k.key),
    }));
  }

  return _config;
}

export interface RedisConnectionConfig {
  host?: string;
  port: number;
  password?: string;
  db: number;
  url?: string;
}

export function getRedisConfig(): RedisConnectionConfig {
  const url = getEnv('REDIS_URL');
  if (url) {
    return {
      port: 6379,
      db: parseInt(getEnv('REDIS_DB', '0') || '0', 10),
      url,
    };
  }
  return {
    host: getEnv('REDIS_HOST', 'localhost') || 'localhost',
    port: parseInt(getEnv('REDIS_PORT', '6379') || '6379', 10),
    password: getEnv('REDIS_PASSWORD') || undefined,
    db: parseInt(getEnv('REDIS_DB', '0') || '0', 10),
  };
}

export type { IGatewayConfig } from '../types';