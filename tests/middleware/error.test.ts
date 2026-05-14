/**
 * 错误处理中间件测试
 */
import { GatewayError, requireParam, validateString } from '../../src/../src/middleware/error';

describe('GatewayError', () => {
  describe('constructor', () => {
    it('should create error with all properties', () => {
      const error = new GatewayError('Test error', 'invalid_request_error', 400, 'test_code', 'param');
      expect(error.message).toBe('Test error');
      expect(error.errorType).toBe('invalid_request_error');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('test_code');
      expect(error.param).toBe('param');
    });
  });

  describe('static factory methods', () => {
    it('should create invalid request error', () => {
      const error = GatewayError.invalidRequest('Invalid request', 'invalid_param');
      expect(error.statusCode).toBe(400);
      expect(error.errorType).toBe('invalid_request_error');
    });

    it('should create authentication error', () => {
      const error = GatewayError.authenticationError('Invalid API key', 'invalid_key');
      expect(error.statusCode).toBe(401);
      expect(error.errorType).toBe('authentication_error');
    });

    it('should create rate limit error', () => {
      const error = GatewayError.rateLimitError('Rate limit exceeded');
      expect(error.statusCode).toBe(429);
      expect(error.errorType).toBe('rate_limit_error');
    });

    it('should create provider error', () => {
      const error = GatewayError.providerError('Provider failed', 'provider_error');
      expect(error.statusCode).toBe(500);
      expect(error.errorType).toBe('provider_error');
    });

    it('should create internal error', () => {
      const error = GatewayError.internalError('Internal error');
      expect(error.statusCode).toBe(500);
      expect(error.errorType).toBe('internal_error');
    });
  });

  describe('toResponse', () => {
    it('should convert to standard response format', () => {
      const error = new GatewayError('Test error', 'invalid_request_error', 400, 'code', 'param');
      const response = error.toResponse();

      expect(response.error.message).toBe('Test error');
      expect(response.error.type).toBe('invalid_request_error');
      expect(response.error.code).toBe('code');
      expect(response.error.param).toBe('param');
    });
  });

  describe('compatibility getters', () => {
    it('should provide status_code getter', () => {
      const error = new GatewayError('Test', 'invalid_request_error', 400);
      expect(error.status_code).toBe(400);
    });

    it('should provide type getter', () => {
      const error = new GatewayError('Test', 'invalid_request_error', 400);
      expect(error.type).toBe('invalid_request_error');
    });
  });
});

describe('Validation helpers', () => {
  describe('requireParam', () => {
    it('should return value if provided', () => {
      const result = requireParam('test', 'param');
      expect(result).toBe('test');
    });

    it('should throw error if null', () => {
      expect(() => requireParam(null, 'param')).toThrow('Missing required parameter: param');
    });

    it('should throw error if undefined', () => {
      expect(() => requireParam(undefined, 'param')).toThrow('Missing required parameter: param');
    });
  });

  describe('validateString', () => {
    it('should return string if valid', () => {
      const result = validateString('test', 'field');
      expect(result).toBe('test');
    });

    it('should throw if too short', () => {
      expect(() => validateString('ab', 'field', { minLength: 3 })).toThrow();
    });

    it('should throw if too long', () => {
      expect(() => validateString('abcdef', 'field', { maxLength: 3 })).toThrow();
    });

    it('should validate pattern', () => {
      expect(() => validateString('abc', 'field', { pattern: /^[0-9]+$/ })).toThrow();
    });
  });
});