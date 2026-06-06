import { scanAndMask, createPiiPlugin, createPiiBlockGuardrail } from '../../../src/plugins/guardrails/pii';
import { resetPluginManager } from '../../../src/plugins';

describe('PII Detection & Redaction', () => {
  beforeEach(() => {
    resetPluginManager();
  });

  describe('scanAndMask', () => {
    it('should mask email addresses', () => {
      const result = scanAndMask('Contact me at alice@example.com please', ['email']);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].ruleId).toBe('email');
      expect(result.maskedText).toContain('a***e@example.com');
    });

    it('should mask China mobile phones', () => {
      const result = scanAndMask('My number is 13812345678', ['phone_cn']);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].ruleId).toBe('phone_cn');
      expect(result.maskedText).toContain('138****5678');
    });

    it('should mask China ID card', () => {
      const result = scanAndMask('ID: 110101199001011234', ['id_card']);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].ruleId).toBe('id_card');
      expect(result.maskedText).toContain('110101********1234');
    });

    it('should mask IPv4 addresses', () => {
      const result = scanAndMask('Server at 192.168.1.1', ['ip_address']);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].ruleId).toBe('ip_address');
      expect(result.maskedText).toContain('192.168.***.***');
    });

    it('should mask API keys', () => {
      const result = scanAndMask('Key: sk-abcdefghijklmnopqrstuvwxyz1234', ['api_key']);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].ruleId).toBe('api_key');
      expect(result.maskedText).toContain('sk-****1234');
    });

    it('should not mask when rule is not enabled', () => {
      const result = scanAndMask('Email: test@example.com', ['phone_cn']);
      expect(result.detections).toHaveLength(0);
      expect(result.maskedText).toBe('Email: test@example.com');
    });

    it('should handle text longer than 4000 chars (only scan first 4000)', () => {
      const longText = 'a'.repeat(5000);
      const result = scanAndMask(longText, ['email']);
      expect(result.maskedText.length).toBe(5000);
    });

    it('should validate credit card with Luhn check', () => {
      // 使用一个有效的 Luhn 校验卡号 (测试卡 4532015112830366)
      const result = scanAndMask('Card: 4532 0151 1283 0366', ['credit_card']);
      expect(result.detections).toHaveLength(1);
      expect(result.maskedText).toContain('****-****-****-0366');
    });

    it('should not mask invalid credit card (Luhn fail)', () => {
      const result = scanAndMask('Card: 1234 5678 9012 3456', ['credit_card']);
      expect(result.detections).toHaveLength(0);
      expect(result.maskedText).toContain('1234 5678 9012 3456');
    });
  });

  describe('createPiiPlugin', () => {
    it('should create a transform plugin', () => {
      const plugin = createPiiPlugin({ enabled: true, action: 'mask', rules: ['email'] });
      expect(plugin.config.id).toBe('pii-redaction');
      expect(plugin.config.type).toBe('transform');
      expect(plugin.config.enabled).toBe(true);
    });

    it('should mask messages in transform', async () => {
      const plugin = createPiiPlugin({ enabled: true, action: 'mask', rules: ['email'] });
      const mockContext = { get: () => undefined } as unknown as import('hono').Context;
      const data = { messages: [{ role: 'user', content: 'Email: alice@example.com' }] };
      const result = await plugin.transform(mockContext, data);
      const messages = (result as { messages: Array<{ content: string }> }).messages;
      expect(messages[0].content).toContain('a***e@example.com');
    });

    it('should pass through non-message data unchanged', async () => {
      const plugin = createPiiPlugin({ enabled: true, action: 'mask', rules: ['email'] });
      const mockContext = { get: () => undefined } as unknown as import('hono').Context;
      const data = { model: 'gpt-4' };
      const result = await plugin.transform(mockContext, data);
      expect(result).toEqual(data);
    });
  });

  describe('createPiiBlockGuardrail', () => {
    it('should block when PII is detected', async () => {
      const plugin = createPiiBlockGuardrail({ enabled: true, rules: ['email'] });
      const mockContext = {} as unknown as import('hono').Context;
      const data = { messages: [{ content: 'Email: alice@example.com' }] };
      const result = await plugin.check(mockContext, data);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('PII detected');
    });

    it('should allow when no PII is detected', async () => {
      const plugin = createPiiBlockGuardrail({ enabled: true, rules: ['email'] });
      const mockContext = {} as unknown as import('hono').Context;
      const data = { messages: [{ content: 'Hello world' }] };
      const result = await plugin.check(mockContext, data);
      expect(result.allowed).toBe(true);
    });
  });
});
