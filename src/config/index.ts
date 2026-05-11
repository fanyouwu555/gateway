/**
 * 配置管理模块
 * 从环境变量和配置文件加载配置
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { IGatewayConfig, IProviderConfig } from '../types';
import { getEnv } from '../utils';

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
        { model: 'gpt-4o', provider: 'openai' },
        { model: 'gpt-4o-mini', provider: 'openai' },
        { model: 'deepseek-chat', provider: 'deepseek' },
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
    healthCheckModel: 'gpt-4o-mini',
  },
  loadBalance: {
    strategy: 'roundRobin',
    providers: {},
  },
};

/**
 * 加载配置文件
 */
function loadConfigFile(configPath?: string): Partial<IGatewayConfig> {
  const path = configPath || getEnv('CONFIG_PATH', './conf/default.json');

  try {
    const content = readFileSync(resolve(path), 'utf-8');
    return JSON.parse(content);
  } catch {
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

  // 从环境变量读取Provider配置
  const openaiKey = getEnv('OPENAI_API_KEY');
  if (openaiKey) {
    config.providers.openai = {
      provider: 'openai',
      base_url: getEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      api_key: openaiKey,
    };
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

  return config;
}

/**
 * 初始化配置
 */
export function initConfig(configPath?: string): IGatewayConfig {
  const fileConfig = loadConfigFile(configPath);
  let config = { ...DEFAULT_CONFIG, ...fileConfig };
  config = overrideFromEnv(config);

  // 验证必填字段
  if (!config.port || config.port <= 0) {
    throw new Error('Invalid port configuration');
  }

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
 * 重新加载配置
 */
export function reloadConfig(configPath?: string): IGatewayConfig {
  _config = initConfig(configPath);
  return _config;
}

export type { IGatewayConfig } from '../types';