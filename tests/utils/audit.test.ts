import { writeAudit, auditGuardrail, auditAdmin, hashContent } from '../../src/utils/audit';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join as pathJoin } from 'path';

const LOG_DIR = './logs';

describe('Audit Log Utility', () => {
  afterEach(() => {
    // 清理当天审计日志文件
    const date = new Date().toISOString().slice(0, 10);
    const auditFile = pathJoin(LOG_DIR, `audit-${date}.log`);
    if (existsSync(auditFile)) {
      unlinkSync(auditFile);
    }
  });

  it('should write audit event to file', () => {
    writeAudit({
      timestamp: new Date().toISOString(),
      event_type: 'guardrail.triggered',
      rule_id: 'test-rule',
      action: 'block',
      severity: 'high',
    });

    const date = new Date().toISOString().slice(0, 10);
    const auditFile = pathJoin(LOG_DIR, `audit-${date}.log`);
    expect(existsSync(auditFile)).toBe(true);

    const content = readFileSync(auditFile, 'utf-8');
    const lines = content.trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.event_type).toBe('guardrail.triggered');
    expect(event.rule_id).toBe('test-rule');
    expect(event.severity).toBe('high');
  });

  it('should compute sha256 content hash', () => {
    const hash = hashContent('hello world');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Verify deterministic hash
    const hash2 = hashContent('hello world');
    expect(hash).toBe(hash2);
  });

  it('should write guardrail audit event via convenience function', () => {
    auditGuardrail({
      requestId: 'req-123',
      tenantId: 'tenant-abc',
      ruleId: 'pii-email',
      action: 'mask',
      reason: 'Email detected',
      contentHash: 'sha256:abc',
      severity: 'medium',
    });

    const date = new Date().toISOString().slice(0, 10);
    const auditFile = pathJoin(LOG_DIR, `audit-${date}.log`);
    const content = readFileSync(auditFile, 'utf-8');
    const lines = content.trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.event_type).toBe('guardrail.masked');
    expect(event.request_id).toBe('req-123');
    expect(event.content_hash).toBe('sha256:abc');
  });

  it('should write admin audit event via convenience function', () => {
    auditAdmin({
      tenantId: 'tenant-xyz',
      ruleId: 'admin.key_created',
      action: 'allow',
      metadata: { key_name: 'test-key' },
      severity: 'low',
    });

    const date = new Date().toISOString().slice(0, 10);
    const auditFile = pathJoin(LOG_DIR, `audit-${date}.log`);
    const content = readFileSync(auditFile, 'utf-8');
    const lines = content.trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.event_type).toBe('admin.key_created');
    expect(event.metadata).toEqual({ key_name: 'test-key' });
  });
});
