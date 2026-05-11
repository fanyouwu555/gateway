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