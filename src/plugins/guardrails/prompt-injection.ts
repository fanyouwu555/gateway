/**
 * 提示注入检测 Guardrail 插件
 * 3 个敏感度级别，基于关键词和模式匹配
 */
import type { Context } from 'hono';
import type { GuardrailPlugin } from '../index';
import { auditGuardrail, hashContent } from '../../utils/audit';

export type InjectionLevel = 'low' | 'medium' | 'high';

/** 检测模式定义 */
interface InjectionPattern {
  id: string;
  name: string;
  patterns: RegExp[];
  severity: 'medium' | 'high';
}

/** 各级别对应的检测模式 */
const INJECTION_PATTERNS: Record<InjectionLevel, InjectionPattern[]> = {
  low: [
    {
      id: 'ignore-instructions',
      name: 'Ignore Previous Instructions',
      patterns: [
        /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|commands?)/i,
        /forget\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)/i,
        /disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|prompts?)/i,
      ],
      severity: 'high',
    },
    {
      id: 'dan-jailbreak',
      name: 'DAN / Jailbreak',
      patterns: [
        /\bDAN\b.*(?:do anything now|no restrictions|no limits)/i,
        /jailbreak\s*(?:mode|activated|enabled)/i,
        /(?:developer|debug|admin)\s*mode\s*(?:on|activated)/i,
      ],
      severity: 'high',
    },
  ],
  medium: [
    {
      id: 'ignore-instructions',
      name: 'Ignore Previous Instructions',
      patterns: [
        /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|commands?)/i,
        /forget\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)/i,
        /disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|prompts?)/i,
      ],
      severity: 'high',
    },
    {
      id: 'dan-jailbreak',
      name: 'DAN / Jailbreak',
      patterns: [
        /\bDAN\b.*(?:do anything now|no restrictions|no limits)/i,
        /jailbreak\s*(?:mode|activated|enabled)/i,
        /(?:developer|debug|admin)\s*mode\s*(?:on|activated)/i,
      ],
      severity: 'high',
    },
    {
      id: 'system-delimiter',
      name: 'System Delimiter Injection',
      patterns: [
        /#{3,}\s*(?:System|SYSTEM|system)\s*#{3,}/,
        /\[\[(?:SYSTEM|system)\]\]/,
        /<{3,}\s*(?:SYSTEM|system)\s*>{3,}/,
        /---\s*(?:SYSTEM|system)\s*---/,
      ],
      severity: 'medium',
    },
  ],
  high: [
    {
      id: 'ignore-instructions',
      name: 'Ignore Previous Instructions',
      patterns: [
        /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|commands?)/i,
        /forget\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)/i,
        /disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|prompts?)/i,
      ],
      severity: 'high',
    },
    {
      id: 'dan-jailbreak',
      name: 'DAN / Jailbreak',
      patterns: [
        /\bDAN\b.*(?:do anything now|no restrictions|no limits)/i,
        /jailbreak\s*(?:mode|activated|enabled)/i,
        /(?:developer|debug|admin)\s*mode\s*(?:on|activated)/i,
      ],
      severity: 'high',
    },
    {
      id: 'system-delimiter',
      name: 'System Delimiter Injection',
      patterns: [
        /#{3,}\s*(?:System|SYSTEM|system)\s*#{3,}/,
        /\[\[(?:SYSTEM|system)\]\]/,
        /<{3,}\s*(?:SYSTEM|system)\s*>{3,}/,
        /---\s*(?:SYSTEM|system)\s*---/,
      ],
      severity: 'medium',
    },
    {
      id: 'role-play',
      name: 'Role Play Injection',
      patterns: [
        /pretend\s+(?:you are|to be|that you are)\s+(?:an?\s+)?(?:AI|assistant|system|developer|admin)/i,
        /act\s+as\s+(?:if\s+)?you\s+(?:are|were)\s+(?:an?\s+)?(?:AI|assistant|system|developer|admin)/i,
        /from\s+now\s+on\s+you\s+are\s+(?:an?\s+)?(?:AI|assistant|system)/i,
      ],
      severity: 'medium',
    },
    {
      id: 'multi-lang-injection',
      name: 'Multi-language Injection',
      patterns: [
        /忽略(?:所有)?(?:之前的|上面的)(?:指令|提示|命令)/,
        /忘记(?:所有)?(?:之前的|上面的)(?:指令|提示)/,
        /無視(?:すべての)?(?:以前の|上記の)(?:指示|プロンプト)/,
        /ignorar\s+(?:todas\s+las\s+)?(?:instrucciones|indicaciones)\s+(?:anteriores|previas)/i,
      ],
      severity: 'high',
    },
  ],
};

/** 扫描文本中的注入攻击 */
export function scanInjection(text: string, level: InjectionLevel): Array<{ id: string; name: string; matched: string; severity: string }> {
  const patterns = INJECTION_PATTERNS[level] || INJECTION_PATTERNS.medium;
  const results: ReturnType<typeof scanInjection> = [];

  for (const patternGroup of patterns) {
    for (const regex of patternGroup.patterns) {
      const match = text.match(regex);
      if (match) {
        results.push({
          id: patternGroup.id,
          name: patternGroup.name,
          matched: match[0],
          severity: patternGroup.severity,
        });
        break; // 同一组内只匹配一次
      }
    }
  }

  return results;
}

/** 创建提示注入 Guardrail 插件 */
export function createPromptInjectionGuardrail(options?: {
  enabled?: boolean;
  level?: InjectionLevel;
}): GuardrailPlugin {
  const enabled = options?.enabled ?? (process.env.GUARDRAIL_PROMPT_INJECTION_ENABLED === 'true');
  const level: InjectionLevel = options?.level ?? (process.env.GUARDRAIL_PROMPT_INJECTION_LEVEL as InjectionLevel) ?? 'medium';

  return {
    config: {
      id: 'prompt-injection-guard',
      name: 'Prompt Injection Guardrail',
      type: 'guardrail',
      enabled,
      priority: 100,
      settings: { level },
    },
    async check(c: Context, data: unknown): Promise<{ allowed: boolean; reason?: string }> {
      // 允许 admin key 通过 header 跳过检测
      const skipHeader = c.req.header('x-guardrail-skip');
      const apiKeyMeta = c.get('api_key_meta') as { is_admin?: boolean } | undefined;
      if (skipHeader === 'prompt-injection' && apiKeyMeta?.is_admin) {
        return { allowed: true };
      }

      const request = data as { messages?: Array<{ content?: string }> };
      if (!request.messages) return { allowed: true };

      for (const msg of request.messages) {
        if (!msg.content) continue;
        const findings = scanInjection(msg.content, level);
        if (findings.length > 0) {
          const first = findings[0];
          // 记录审计日志
          auditGuardrail({
            requestId: c.get('request_id'),
            tenantId: c.get('tenant_id'),
            ruleId: `injection-${first.id}`,
            action: 'block',
            reason: `Detected ${first.name}: "${first.matched}"`,
            contentHash: hashContent(msg.content),
            severity: first.severity as 'medium' | 'high',
          });

          const ids = findings.map((f) => f.name).join(', ');
          return { allowed: false, reason: `Prompt injection detected: ${ids}. Request blocked.` };
        }
      }

      return { allowed: true };
    },
  };
}

export { INJECTION_PATTERNS };
