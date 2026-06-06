/**
 * 轻量分布式 Tracing 模块
 * 简化版 OpenTelemetry，只引入 3 个包，默认关闭
 */
import { trace, type Tracer, type Span, type SpanContext, context } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { writeLog } from './logger';

const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';
const OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'ai-gateway';
const OTEL_SAMPLER_RATIO = parseFloat(process.env.OTEL_TRACE_SAMPLER_RATIO || '0.1');

let provider: BasicTracerProvider | null = null;
let tracer: Tracer | null = null;

/**
 * 初始化 Tracing Provider
 */
export function initTracing(): void {
  if (!OTEL_ENABLED) {
    writeLog('info', 'OpenTelemetry tracing is disabled');
    return;
  }

  try {
    provider = new BasicTracerProvider({
      resource: {
        attributes: {
          'service.name': OTEL_SERVICE_NAME,
        },
        merge: () => ({
          attributes: {
            'service.name': OTEL_SERVICE_NAME,
          },
        }),
      } as unknown as NonNullable<ConstructorParameters<typeof BasicTracerProvider>[0]>['resource'],
    });

    const exporter = new OTLPTraceExporter({ url: OTEL_ENDPOINT });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));

    provider.register();
    tracer = trace.getTracer('ai-gateway', '1.0.0');

    writeLog('info', 'OpenTelemetry tracing initialized', {
      endpoint: OTEL_ENDPOINT,
      service: OTEL_SERVICE_NAME,
      sampleRatio: OTEL_SAMPLER_RATIO,
    });
  } catch (err) {
    writeLog('error', 'Failed to initialize OpenTelemetry tracing', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 是否采样当前请求
 */
function shouldSample(): boolean {
  if (!OTEL_ENABLED || OTEL_SAMPLER_RATIO >= 1) return true;
  return Math.random() < OTEL_SAMPLER_RATIO;
}

/**
 * 创建 Root Span（用于 HTTP 请求）
 */
export function createRootSpan(name: string, parentContext?: SpanContext): Span | null {
  if (!tracer || !shouldSample()) return null;

  const options: { links?: Array<{ context: SpanContext }> } = {};
  if (parentContext) {
    options.links = [{ context: parentContext }];
  }

  return tracer.startSpan(name, options);
}

/**
 * 创建 Child Span
 */
export function createChildSpan(parent: Span | null, name: string): Span | null {
  if (!tracer || !parent) return null;

  const ctx = trace.setSpan(context.active(), parent);
  return tracer.startSpan(name, undefined, ctx);
}

/**
 * 记录 Span 错误
 */
export function setSpanError(span: Span | null, error: Error | string): void {
  if (!span) return;
  const msg = typeof error === 'string' ? error : error.message;
  span.setAttribute('error', true);
  span.setAttribute('error.message', msg);
  if (typeof error !== 'string') {
    span.setAttribute('error.type', error.name || 'Error');
  }
}

/**
 * 结束 Span
 */
export function endSpan(span: Span | null): void {
  if (span) {
    span.end();
  }
}

/**
 * 获取当前 Tracer（用于手动创建 span）
 */
export function getTracer(): Tracer | null {
  return tracer;
}

/**
 * 从 traceparent header 解析 SpanContext
 */
export function parseTraceParent(header: string): SpanContext | undefined {
  // traceparent 格式: 00-{traceId}-{spanId}-{flags}
  const parts = header.split('-');
  if (parts.length !== 4 || parts[0] !== '00') return undefined;

  const traceId = parts[1];
  const spanId = parts[2];
  const flags = parseInt(parts[3], 16);

  return {
    traceId,
    spanId,
    traceFlags: flags,
    isRemote: true,
  };
}
