/**
 * PII 检测与脱敏插件
 * 内置 7 类正则规则，支持 mask / block / log_only 三种策略
 * 扫描范围限制在前 4000 字符，避免长文本性能问题
 */
import type { Context } from 'hono';
import type { TransformPlugin } from '../index';
import { auditGuardrail, hashContent } from '../../utils/audit';

export type PiiAction = 'mask' | 'block' | 'log_only';

/** 单个 PII 规则定义 */
interface PiiRule {
  id: string;
  name: string;
  pattern: RegExp;
  mask: (match: string) => string;
  severity: 'low' | 'medium' | 'high';
}

/** 预编译的 PII 规则库 */
const PII_RULES: PiiRule[] = [
  {
    id: 'email',
    name: 'Email Address',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    mask: (m) => {
      const [local, domain] = m.split('@');
      const maskedLocal = local.length > 2 ? local[0] + '*'.repeat(local.length - 2) + local[local.length - 1] : '*'.repeat(local.length);
      return `${maskedLocal}@${domain}`;
    },
    severity: 'medium',
  },
  {
    id: 'phone_cn',
    name: 'China Mobile Phone',
    pattern: /(?:\+?86[-\s]?)?1[3-9]\d{9}/g,
    mask: (m) => m.slice(0, 3) + '****' + m.slice(-4),
    severity: 'high',
  },
  {
    id: 'phone_intl',
    name: 'International Phone',
    pattern: /\+\d{1,3}[-\s]?\d{1,14}(?:[-\s]?\d{1,13})?/g,
    mask: (m) => {
      const visible = 4;
      return m.length > visible ? '*'.repeat(m.length - visible) + m.slice(-visible) : '*'.repeat(m.length);
    },
    severity: 'medium',
  },
  {
    id: 'id_card',
    name: 'China ID Card',
    pattern: /\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g,
    mask: (m) => m.slice(0, 6) + '*'.repeat(8) + m.slice(-4),
    severity: 'high',
  },
  {
    id: 'credit_card',
    name: 'Credit Card',
    pattern: /(?:\d{4}[-\s]?){3}\d{4}/g,
    mask: (m) => {
      const digits = m.replace(/\D/g, '');
      if (!luhnCheck(digits)) return m; // Luhn 校验不通过则保留原文
      return '****-****-****-' + digits.slice(-4);
    },
    severity: 'high',
  },
  {
    id: 'ip_address',
    name: 'IP Address',
    pattern: /(?:\d{1,3}\.){3}\d{1,3}/g,
    mask: (m) => {
      const parts = m.split('.');
      return `${parts[0]}.${parts[1]}.***.***`;
    },
    severity: 'low',
  },
  {
    id: 'api_key',
    name: 'API Key',
    pattern: /(?:sk-[a-zA-Z0-9]{24,}|AK[0-9A-Za-z]{16,})/g,
    mask: (m) => {
      if (m.startsWith('sk-')) {
        return 'sk-****' + m.slice(-4);
      }
      return m.slice(0, 4) + '****' + m.slice(-4);
    },
    severity: 'medium',
  },
];

/** Luhn 校验算法 */
function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits.substring(i, i + 1), 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** PII 扫描结果 */
interface PiiScanResult {
  maskedText: string;
  detections: Array<{ ruleId: string; severity: string; original: string; masked: string }>;
}

/** 扫描并脱敏文本 */
export function scanAndMask(text: string, enabledRules: string[]): PiiScanResult {
  const scanLength = Math.min(text.length, 4000);
  const toScan = text.slice(0, scanLength);
  const rest = text.slice(scanLength);

  let masked = toScan;
  const detections: PiiScanResult['detections'] = [];

  for (const rule of PII_RULES) {
    if (!enabledRules.includes(rule.id)) continue;

    masked = masked.replace(rule.pattern, (match) => {
      const replacement = rule.mask(match);
      if (replacement !== match) {
        detections.push({
          ruleId: rule.id,
          severity: rule.severity,
          original: match,
          masked: replacement,
        });
      }
      return replacement;
    });
  }

  return { maskedText: masked + rest, detections };
}

/** 创建 PII 脱敏插件 */
export function createPiiPlugin(options?: {
  enabled?: boolean;
  action?: PiiAction;
  rules?: string[];
}): TransformPlugin {
  const enabled = options?.enabled ?? (process.env.GUARDRAIL_PII_ENABLED === 'true');
  const action: PiiAction = options?.action ?? (process.env.GUARDRAIL_PII_ACTION as PiiAction) ?? 'mask';
  const rules = options?.rules ?? (process.env.GUARDRAIL_PII_RULES?.split(',') ?? PII_RULES.map((r) => r.id));

  return {
    config: {
      id: 'pii-redaction',
      name: 'PII Redaction',
      type: 'transform',
      enabled,
      priority: 90,
      settings: { action, rules },
    },
    async transform(c: Context, data: unknown): Promise<unknown> {
      if (action === 'log_only') {
        const request = data as { messages?: Array<{ content?: string }> };
        if (request.messages) {
          for (const msg of request.messages) {
            if (msg.content) {
              const { detections } = scanAndMask(msg.content, rules);
              for (const d of detections) {
                auditGuardrail({
                  requestId: c.get('request_id'),
                  tenantId: c.get('tenant_id'),
                  ruleId: `pii-${d.ruleId}`,
                  action: 'log_only',
                  reason: `Detected ${d.ruleId}: ${d.original}`,
                  contentHash: hashContent(msg.content),
                  severity: d.severity as 'low' | 'medium' | 'high',
                });
              }
            }
          }
        }
        return data;
      }

      if (action === 'block') {
        const request = data as { messages?: Array<{ content?: string }> };
        if (request.messages) {
          for (const msg of request.messages) {
            if (msg.content) {
              const { detections } = scanAndMask(msg.content, rules);
              if (detections.length > 0) {
                for (const d of detections) {
                  auditGuardrail({
                    requestId: c.get('request_id'),
                    tenantId: c.get('tenant_id'),
                    ruleId: `pii-${d.ruleId}`,
                    action: 'block',
                    reason: `Detected ${d.ruleId}: ${d.original}`,
                    contentHash: hashContent(msg.content),
                    severity: d.severity as 'low' | 'medium' | 'high',
                  });
                }
              }
            }
          }
        }
        return data;
      }

      const request = data as { messages?: Array<{ content?: string }> };
      if (!request.messages) return data;

      const modifiedMessages = request.messages.map((msg) => {
        if (!msg.content) return msg;
        const { maskedText, detections } = scanAndMask(msg.content, rules);
        for (const d of detections) {
          auditGuardrail({
            requestId: c.get('request_id'),
            tenantId: c.get('tenant_id'),
            ruleId: `pii-${d.ruleId}`,
            action: 'mask',
            reason: `Masked ${d.ruleId}: ${d.original} -> ${d.masked}`,
            contentHash: hashContent(msg.content),
            severity: d.severity as 'low' | 'medium' | 'high',
          });
        }
        return { ...msg, content: maskedText };
      });

      return { ...request, messages: modifiedMessages };
    },
  };
}

/** 创建 PII Block Guardrail（用于 block 模式时拦截请求） */
export function createPiiBlockGuardrail(options?: {
  enabled?: boolean;
  rules?: string[];
}): import('../index').GuardrailPlugin {
  const enabled = options?.enabled ?? (process.env.GUARDRAIL_PII_ENABLED === 'true' && process.env.GUARDRAIL_PII_ACTION === 'block');
  const rules = options?.rules ?? (process.env.GUARDRAIL_PII_RULES?.split(',') ?? PII_RULES.map((r) => r.id));

  return {
    config: {
      id: 'pii-block',
      name: 'PII Block Guardrail',
      type: 'guardrail',
      enabled,
      priority: 95,
      settings: { rules },
    },
    async check(_c: Context, data: unknown): Promise<{ allowed: boolean; reason?: string }> {
      const request = data as { messages?: Array<{ content?: string }> };
      if (!request.messages) return { allowed: true };

      for (const msg of request.messages) {
        if (msg.content) {
          const { detections } = scanAndMask(msg.content, rules);
          if (detections.length > 0) {
            const ids = detections.map((d) => d.ruleId).join(', ');
            return { allowed: false, reason: `PII detected (${ids}). Request blocked by policy.` };
          }
        }
      }
      return { allowed: true };
    },
  };
}

export { PII_RULES };
