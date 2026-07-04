/**
 * 价格计算服务
 * 管理模型定价，支持配置加载和运行时覆盖
 */
export interface ModelPrice {
  input: number;   // 每 1M tokens 输入价格（元）
  output: number;  // 每 1M tokens 输出价格（元）
}

export type PricingMap = Record<string, ModelPrice>;

// 模型未配置定价时的默认价格
const DEFAULT_INPUT_PRICE = 30;
const DEFAULT_OUTPUT_PRICE = 60;

class PricingService {
  private configPrices: PricingMap = {};
  private overrides: PricingMap = {};

  /**
   * 从配置初始化定价
   */
  initialize(pricing?: PricingMap): void {
    this.configPrices = pricing || {};
    this.overrides = {};
  }

  /**
   * 获取某个模型的价格（overrides > config > default）
   */
  getPrice(model: string): ModelPrice {
    const override = this.overrides[model];
    if (override) return override;

    const config = this.configPrices[model];
    if (config) return config;

    const defaultPrice = this.configPrices['__default__'];
    if (defaultPrice) return defaultPrice;

    return { input: DEFAULT_INPUT_PRICE, output: DEFAULT_OUTPUT_PRICE };
  }

  /**
   * 运行时覆盖某个模型的价格
   */
  setPrice(model: string, input: number, output: number): void {
    this.overrides[model] = { input, output };
  }

  /**
   * 删除运行时覆盖，回退到配置值
   */
  deletePrice(model: string): boolean {
    if (this.overrides[model]) {
      delete this.overrides[model];
      return true;
    }
    return false;
  }

  /**
   * 获取所有价格（配置 + overrides，overrides 优先）
   */
  getAllPrices(): PricingMap {
    const merged = { ...this.configPrices, ...this.overrides };
    const result: PricingMap = {};
    for (const [key, val] of Object.entries(merged)) {
      if (key !== '__default__') {
        result[key] = val;
      }
    }
    return result;
  }

  /**
   * 获取运行时 overrides
   */
  getOverrides(): PricingMap {
    return { ...this.overrides };
  }

  /**
   * 计算请求费用
   */
  calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    const { input, output } = this.getPrice(model);
    return (promptTokens * input + completionTokens * output) / 1_000_000;
  }

  /**
   * 重置所有运行时覆盖
   */
  resetOverrides(): void {
    this.overrides = {};
  }
}

const pricingService = new PricingService();

export function getPricingService(): PricingService {
  return pricingService;
}

export { PricingService };
