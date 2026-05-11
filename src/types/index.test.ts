/**
 * 类型定义测试
 * 验证类型正确性
 */
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  IProviderConfig,
  IGatewayConfig,
  IApiKeyMeta,
  IAuthResult,
  IRequestLog,
  GatewayErrorType,
} from '../types';

describe('Types', () => {
  describe('ChatCompletionRequest', () => {
    it('should allow valid request structure', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello!' },
        ],
        temperature: 0.7,
        max_tokens: 100,
        stream: false,
      };
      expect(request.model).toBe('gpt-4o');
      expect(request.messages).toHaveLength(2);
      expect(request.stream).toBe(false);
    });

    it('should allow optional fields', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      };
      expect(request.temperature).toBeUndefined();
    });
  });

  describe('ChatCompletionResponse', () => {
    it('should allow valid response structure', () => {
      const response: ChatCompletionResponse = {
        id: 'chat-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };
      expect(response.id).toBe('chat-123');
      expect(response.choices[0].finish_reason).toBe('stop');
    });
  });

  describe('IProviderConfig', () => {
    it('should allow valid provider config', () => {
      const config: IProviderConfig = {
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test',
        timeout: 30000,
        max_retries: 3,
      };
      expect(config.provider).toBe('openai');
    });
  });

  describe('IGatewayConfig', () => {
    it('should allow valid gateway config', () => {
      const config: IGatewayConfig = {
        port: 3000,
        host: '0.0.0.0',
        log_level: 'info',
        providers: {},
        routing: [{ name: 'default', rules: [] }],
        auth: { enabled: true, api_keys: [] },
        rate_limit: { enabled: true, qps: 10, burst: 20 },
      };
      expect(config.port).toBe(3000);
    });
  });

  describe('IApiKeyMeta', () => {
    it('should allow valid API key metadata', () => {
      const keyMeta: IApiKeyMeta = {
        key: 'sk-test-123',
        tenant_id: 'tenant-1',
        name: 'Test Key',
        created_at: Date.now(),
        expires_at: Date.now() + 86400000,
        limits: { daily_requests: 1000, daily_tokens: 100000 },
      };
      expect(keyMeta.tenant_id).toBe('tenant-1');
    });
  });

  describe('IAuthResult', () => {
    it('should allow valid auth result - success', () => {
      const result: IAuthResult = {
        valid: true,
        tenant_id: 'tenant-1',
      };
      expect(result.valid).toBe(true);
    });

    it('should allow valid auth result - failure', () => {
      const result: IAuthResult = {
        valid: false,
        error: 'Invalid API key',
      };
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid API key');
    });
  });

  describe('IRequestLog', () => {
    it('should allow valid request log', () => {
      const log: IRequestLog = {
        request_id: 'req-123',
        tenant_id: 'tenant-1',
        timestamp: Date.now(),
        method: 'POST',
        path: '/v1/chat/completions',
        provider: 'openai',
        model: 'gpt-4o',
        status_code: 200,
        duration_ms: 100,
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      };
      expect(log.status_code).toBe(200);
    });
  });

  describe('GatewayErrorType', () => {
    it('should allow all error types', () => {
      const errorTypes: GatewayErrorType[] = [
        'invalid_request_error',
        'authentication_error',
        'rate_limit_error',
        'provider_error',
        'internal_error',
      ];
      expect(errorTypes).toHaveLength(5);
    });
  });
});