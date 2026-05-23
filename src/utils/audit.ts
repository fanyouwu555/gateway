/**
 * 审计日志模块
 * 独立写入器，与系统日志分离，满足合规要求
 * 格式：JSON Lines，存储于 logs/audit-YYYY-MM-DD.log
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const AUDIT_LOG_DIR = process.env.LOG_DIR || './logs';
const AUDIT_LOG_RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);

let currentAuditFile = '';
let currentAuditDate = '';

/** 审计事件类型 */
export type AuditEventType =
  | 'guardrail.triggered'
  | 'guardrail.masked'
  | 'admin.key_created'
  | 'admin.key_deleted'
  | 'admin.config_updated'
  | 'admin.tenant_created';

/** 审计严重级别 */
export type AuditSeverity = 'low' | 'medium' | 'high' | 'critical';

/** 审计事件结构 */
export interface AuditEvent {
  timestamp: string;
  event_type: AuditEventType;
  request_id?: string;
  tenant_id?: string;
  rule_id: string;
  action: 'block' | 'mask' | 'log_only' | 'allow';
  reason?: string;
  content_hash?: string;
  severity: AuditSeverity;
  metadata?: Record<string, unknown>;
}

function ensureAuditDir(): void {
  if (!existsSync(AUDIT_LOG_DIR)) {
    mkdirSync(AUDIT_LOG_DIR, { recursive: true });
  }
}

function getAuditFileName(): string {
  const date = new Date().toISOString().slice(0, 10);
  if (date !== currentAuditDate) {
    currentAuditDate = date;
    currentAuditFile = join(AUDIT_LOG_DIR, `audit-${date}.log`);
    ensureAuditDir();
  }
  return currentAuditFile;
}

function cleanOldAuditLogs(): void {
  try {
    if (!existsSync(AUDIT_LOG_DIR)) return;
    const now = Date.now();
    const retentionMs = AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of readdirSync(AUDIT_LOG_DIR)) {
      if (!file.startsWith('audit-') || !file.endsWith('.log')) continue;
      const filePath = join(AUDIT_LOG_DIR, file);
      const stats = statSync(filePath);
      if (now - stats.mtime.getTime() > retentionMs) {
        unlinkSync(filePath);
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
}

// 启动时清理一次过期审计日志
cleanOldAuditLogs();

/**
 * 计算内容哈希（sha256）
 * 用于审计日志中引用消息内容，同时避免存储原文
 */
export function hashContent(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * 写入审计日志
 */
export function writeAudit(event: AuditEvent): void {
  const line = JSON.stringify(event);
  try {
    const logFile = getAuditFileName();
    appendFileSync(logFile, line + '\n', { encoding: 'utf-8' });
  } catch {
    // 文件写入失败静默处理，不阻断主流程
  }
}

/**
 * 便捷方法：记录 Guardrail 触发事件
 */
export function auditGuardrail(params: {
  requestId?: string;
  tenantId?: string;
  ruleId: string;
  action: 'block' | 'mask' | 'log_only';
  reason?: string;
  contentHash?: string;
  severity: AuditSeverity;
}): void {
  const eventType: AuditEventType = params.action === 'mask' ? 'guardrail.masked' : 'guardrail.triggered';
  writeAudit({
    timestamp: new Date().toISOString(),
    event_type: eventType,
    request_id: params.requestId,
    tenant_id: params.tenantId,
    rule_id: params.ruleId,
    action: params.action,
    reason: params.reason,
    content_hash: params.contentHash,
    severity: params.severity,
  });
}

/**
 * 便捷方法：记录 Admin 操作事件
 */
export function auditAdmin(params: {
  tenantId?: string;
  ruleId: string;
  action: 'allow';
  metadata?: Record<string, unknown>;
  severity?: AuditSeverity;
}): void {
  writeAudit({
    timestamp: new Date().toISOString(),
    event_type: params.ruleId as AuditEventType,
    tenant_id: params.tenantId,
    rule_id: params.ruleId,
    action: params.action,
    severity: params.severity || 'medium',
    metadata: params.metadata,
  });
}
