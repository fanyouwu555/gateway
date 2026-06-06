/**
 * 统一错误处理中间件
 * 将所有错误转换为标准响应格式
 */

// 简化错误类型
type ErrorType = 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'provider_error' | 'internal_error';

/**
 * Gateway 错误类
 */
export class GatewayError extends Error {
  statusCode: number;
  errorType: ErrorType;
  code?: string;
  param?: string;

  constructor(
    message: string,
    errorType: ErrorType,
    statusCode: number,
    code?: string,
    param?: string
  ) {
    super(message);
    this.name = 'GatewayError';
    this.statusCode = statusCode;
    this.errorType = errorType;
    this.code = code;
    this.param = param;
  }

  /**
   * 转换为标准HTTP响应
   */
  toResponse(): { error: { message: string; type: string; code?: string; param?: string } } {
    return {
      error: {
        message: this.message,
        type: this.errorType,
        code: this.code,
        param: this.param,
      },
    };
  }

  get status_code(): number {
    return this.statusCode;
  }

  get type(): string {
    return this.errorType;
  }

  /**
   * 创建常见错误
   */
  static invalidRequest(message: string, code?: string, param?: string): GatewayError {
    return new GatewayError(message, 'invalid_request_error', 400, code, param);
  }

  static authenticationError(message: string, code?: string): GatewayError {
    return new GatewayError(message, 'authentication_error', 401, code);
  }

  static rateLimitError(message: string): GatewayError {
    return new GatewayError(message, 'rate_limit_error', 429, 'rate_limit_exceeded');
  }

  static providerError(message: string, code?: string): GatewayError {
    return new GatewayError(message, 'provider_error', 500, code);
  }

  static internalError(message: string): GatewayError {
    return new GatewayError(message, 'internal_error', 500, 'internal_error');
  }
}

/**
 * 参数校验辅助函数
 */
export function requireParam<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw GatewayError.invalidRequest(`Missing required parameter: ${name}`, 'missing_param', name);
  }
  return value;
}

export function validateString(
  value: string | undefined,
  name: string,
  options?: { minLength?: number; maxLength?: number; pattern?: RegExp }
): string {
  const str = requireParam(value, name);

  if (options?.minLength && str.length < options.minLength) {
    throw GatewayError.invalidRequest(
      `${name} must be at least ${options.minLength} characters`,
      'invalid_length',
      name
    );
  }

  if (options?.maxLength && str.length > options.maxLength) {
    throw GatewayError.invalidRequest(
      `${name} must be at most ${options.maxLength} characters`,
      'invalid_length',
      name
    );
  }

  if (options?.pattern && !options.pattern.test(str)) {
    throw GatewayError.invalidRequest(
      `${name} has invalid format`,
      'invalid_format',
      name
    );
  }

  return str;
}

/**
 * Provider 错误规范化
 * 将不同 Provider 的错误转换为统一格式
 */
type ProviderErrorResult = {
  message: string;
  type: ErrorType;
  code: string;
  status: number;
};

export function normalizeProviderError(error: unknown, provider?: string): ProviderErrorResult {
  const tag = provider ? `[${provider}] ` : '';

  // HTTP Response 类型错误
  if (error instanceof Response) {
    const status = error.status;
    if (status === 429) {
      return {
        message: `${tag}Rate limited by provider`,
        type: 'rate_limit_error',
        code: 'provider_rate_limited',
        status: 429,
      };
    }
    if (status === 401 || status === 403) {
      return {
        message: `${tag}Provider authentication failed`,
        type: 'authentication_error',
        code: 'provider_auth_failed',
        status: 502,
      };
    }
    if (status >= 500) {
      return {
        message: `${tag}Provider server error (${status})`,
        type: 'provider_error',
        code: 'provider_server_error',
        status: 502,
      };
    }
    return {
      message: `${tag}Provider returned status ${status}`,
      type: 'provider_error',
      code: 'provider_error',
      status: 502,
    };
  }

  // 网络/超时错误
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound')) {
      return {
        message: `${tag}Provider unreachable`,
        type: 'provider_error',
        code: 'provider_unreachable',
        status: 502,
      };
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return {
        message: `${tag}Provider request timed out`,
        type: 'provider_error',
        code: 'provider_timeout',
        status: 504,
      };
    }
    if (msg.includes('rate limit') || msg.includes('too many requests')) {
      return {
        message: `${tag}Rate limited by provider`,
        type: 'rate_limit_error',
        code: 'provider_rate_limited',
        status: 429,
      };
    }
    if (msg.includes('empty') && (msg.includes('response') || msg.includes('reply'))) {
      return {
        message: `${tag}Provider returned empty response`,
        type: 'provider_error',
        code: 'empty_response',
        status: 502,
      };
    }
  }

  // 默认
  return {
    message: `${tag}Provider error`,
    type: 'provider_error',
    code: 'provider_error',
    status: 502,
  };
}