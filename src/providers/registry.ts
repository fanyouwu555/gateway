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
import { volcanoProvider } from './volcano';
import { kimiCodeProvider } from './kimi-code';
import { DynamicProvider } from './dynamic';
import { getConfig } from '../config';
import { writeLog } from '../utils/logger';

/**
 * 验证 Provider base_url 是否安全（防止 SSRF）
 * 拒绝内网地址、localhost、file 协议等
 */
function isValidProviderUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return false;
    }
    if (hostname === '0.0.0.0' || hostname.startsWith('127.')) {
      return false;
    }
    if (hostname.startsWith('10.')) {
      return false;
    }
    if (hostname.startsWith('172.')) {
      const second = parseInt(hostname.split('.')[1], 10);
      if (second >= 16 && second <= 31) return false;
    }
    if (hostname.startsWith('192.168.')) {
      return false;
    }
    if (hostname.startsWith('169.254.')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

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
  registerProvider('volcano', volcanoProvider);
  registerProvider('kimi-code', kimiCodeProvider);

  // 注册动态Provider (从配置)
  const config = getConfig();
  if (config.dynamicProviders && config.dynamicProviders.length > 0) {
    for (const dp of config.dynamicProviders) {
      if (!isValidProviderUrl(dp.base_url)) {
        writeLog('error', 'Dynamic provider base_url rejected for SSRF safety', { name: dp.name, base_url: dp.base_url });
        continue;
      }
      const provider = new DynamicProvider(dp);
      registerProvider(dp.name, provider);
      writeLog('info', 'Registered dynamic provider', { name: dp.name });
    }
  }

  writeLog('info', 'Provider initialization complete', {
    providers: ['openai', 'deepseek', 'anthropic', 'mistral', 'groq', 'google', 'moonshot', 'volcano', 'kimi-code'],
    dynamicCount: config.dynamicProviders?.length || 0,
  });
}

export { openaiProvider, deepseekProvider, anthropicProvider, mistralProvider, groqProvider, googleProvider, moonshotProvider, volcanoProvider, kimiCodeProvider };