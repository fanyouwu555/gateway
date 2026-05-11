/**
 * Provider 初始化
 * 注册所有可用的Provider (内置 + 动态配置)
 */
import { registerProvider } from './index';
import { openaiProvider } from './openai';
import { deepseekProvider } from './deepseek';
import { anthropicProvider } from './anthropic';
import { DynamicProvider } from './dynamic';
import { getConfig } from '../config';

/**
 * 初始化所有Provider
 */
export function initProviders(): void {
  // 注册内置Provider
  registerProvider('openai', openaiProvider);
  registerProvider('deepseek', deepseekProvider);
  registerProvider('anthropic', anthropicProvider);

  // 注册动态Provider (从配置)
  const config = getConfig();
  if (config.dynamicProviders && config.dynamicProviders.length > 0) {
    for (const dp of config.dynamicProviders) {
      const provider = new DynamicProvider(dp);
      registerProvider(dp.name, provider);
      console.log(`[Provider] Registered dynamic provider: ${dp.name}`);
    }
  }

  console.log('[Provider] Initialized: openai, deepseek, anthropic' +
    (config.dynamicProviders?.length ? ` + ${config.dynamicProviders.length} dynamic` : ''));
}

export { openaiProvider, deepseekProvider, anthropicProvider };