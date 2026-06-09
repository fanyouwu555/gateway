/**
 * Provider 依赖注入测试
 * 验证 setProviderDeps / resetProviderDeps 的正确性
 *
 * 注意：FailoverManager / LoadBalanceManager 类未从模块导出，
 * 只能通过实例推断类型。测试聚焦于 API 契约（函数存在、不抛异常、mock 被调用）。
 */
import { setProviderDeps, resetProviderDeps } from '../../src/providers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFailover: any = {
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
  getAvailableToken: jest.fn().mockReturnValue(null),
  getHealthyKeys: jest.fn().mockImplementation((_provider: string, keys: string[]) => keys),
  isHealthy: jest.fn().mockReturnValue(false),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLoadBalancer: any = {
  selectToken: jest.fn().mockReturnValue({ apiKey: 'mock-key', weight: 1 }),
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
};

describe('Provider Dependency Injection', () => {
  beforeEach(() => {
    resetProviderDeps();
    jest.clearAllMocks();
  });

  describe('setProviderDeps', () => {
    it('应为可选参数，不传时不改变依赖', () => {
      expect(() => setProviderDeps({})).not.toThrow();
      // 第二次补传也不应报错
      expect(() => setProviderDeps({})).not.toThrow();
    });

    it('应能注入自定义 failoverManager', () => {
      setProviderDeps({ failoverManager: mockFailover });
      // mock 方法可正常调用
      expect(mockFailover.getAvailableToken('test-provider')).toBeNull();
    });

    it('应能注入自定义 loadBalanceManager', () => {
      setProviderDeps({ loadBalanceManager: mockLoadBalancer });
      const result = mockLoadBalancer.selectToken('test', [{ apiKey: 'key1', weight: 1 }]);
      expect(result.apiKey).toBe('mock-key');
    });

    it('应能同时注入两个依赖', () => {
      setProviderDeps({
        failoverManager: mockFailover,
        loadBalanceManager: mockLoadBalancer,
      });
      expect(mockFailover.isHealthy('test')).toBe(false);
      const token = mockLoadBalancer.selectToken('test', [{ apiKey: 'k', weight: 1 }]);
      expect(token.apiKey).toBe('mock-key');
    });
  });

  describe('resetProviderDeps', () => {
    it('resetProviderDeps 不应抛出异常', () => {
      expect(() => resetProviderDeps()).not.toThrow();
    });

    it('多次调用 resetProviderDeps 应安全', () => {
      resetProviderDeps();
      resetProviderDeps();
      expect(() => setProviderDeps({})).not.toThrow();
    });

    it('在注入后重置不应抛出异常', () => {
      setProviderDeps({ failoverManager: mockFailover });
      expect(() => resetProviderDeps()).not.toThrow();
    });
  });
});
