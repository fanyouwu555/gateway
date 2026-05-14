/**
 * Provider 初始化
 * 注册所有可用的Provider (内置 + 动态配置)
 */
import { registerProvider } from './index';
import { openaiProvider } from './openai';
import { deepseekProvider } from './deepseek';
import { anthropicProvider } from './anthropic';
import { mistralProvider } from './mistral';
import { groqProvider } from './groq';
import { googleProvider } from './google';
import { moonshotProvider } from './moonshot';
import { DynamicProvider } from './dynamic';
import { getConfig } from '../config';
import { writeLog } from '../utils/logger';

/**
 * 初始化所有Provider
 */
export function initProviders(): void {
  // 注册内置Provider
  registerProvider('openai', openaiProvider);
  registerProvider('deepseek', deepseekProvider);
  registerProvider('anthropic', anthropicProvider);
  registerProvider('mistral', mistralProvider);
  registerProvider('groq', groqProvider);
  registerProvider('google', googleProvider);
  registerProvider('moonshot', moonshotProvider);

  // 注册动态Provider (从配置)
  const config = getConfig();
  if (config.dynamicProviders && config.dynamicProviders.length > 0) {
    for (const dp of config.dynamicProviders) {
      const provider = new DynamicProvider(dp);
      registerProvider(dp.name, provider);
      writeLog('info', 'Registered dynamic provider', { name: dp.name });
    }
  }

  writeLog('info', 'Provider initialization complete', {
    providers: ['openai', 'deepseek', 'anthropic', 'mistral', 'groq', 'google', 'moonshot'],
    dynamicCount: config.dynamicProviders?.length || 0,
  });
}

export { openaiProvider, deepseekProvider, anthropicProvider, mistralProvider, groqProvider, googleProvider, moonshotProvider };