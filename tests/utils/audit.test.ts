/**
 * 审计日志工具测试
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const TEST_LOG_DIR = join(process.cwd(), 'logs-test-audit');

function setupTestDir(): void {
  if (existsSync(TEST_LOG_DIR)) {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_LOG_DIR, { recursive: true });
}

describe('Audit utils', () => {
  beforeEach(() => {
    jest.resetModules();
    setupTestDir();
    process.env.LOG_DIR = TEST_LOG_DIR;
  });

  afterEach(() => {
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
  });

  async function loadAudit() {
    const mod = await import('../../src/utils/audit');
    return mod;
  }

  it('should hash content with sha256 prefix', async () => {
    const { hashContent } = await loadAudit();
    const hash = hashContent('hello');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Verify deterministic hash
    const hash2 = hashContent('hello');
    expect(hash).toBe(hash2);
  });

  it('should write and read audit event', async () => {
    const { auditGuardrail, readAuditLogs } = await loadAudit();
    auditGuardrail({
      requestId: 'req-1',
      tenantId: 't1',
      ruleId: 'rule-1',
      action: 'block',
      reason: 'blocked',
      severity: 'high',
    });

    const { logs } = readAuditLogs();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const found = logs.find((l) => l.request_id === 'req-1');
    expect(found).toBeDefined();
    expect(found!.event_type).toBe('guardrail.triggered');
    expect(found!.severity).toBe('high');
  });

  it('should use guardrail.masked event type for mask action', async () => {
    const { auditGuardrail, readAuditLogs } = await loadAudit();
    auditGuardrail({
      ruleId: 'rule-mask',
      action: 'mask',
      severity: 'medium',
    });

    const { logs } = readAuditLogs();
    const found = logs.find((l) => l.rule_id === 'rule-mask');
    expect(found).toBeDefined();
    expect(found!.event_type).toBe('guardrail.masked');
  });

  it('should write admin audit event', async () => {
    const { auditAdmin, readAuditLogs } = await loadAudit();
    auditAdmin({
      tenantId: 't1',
      ruleId: 'admin.key_created',
      action: 'allow',
      severity: 'low',
      metadata: { key: 'value' },
    });

    const { logs } = readAuditLogs();
    const found = logs.find((l) => l.event_type === 'admin.key_created');
    expect(found).toBeDefined();
    expect(found!.action).toBe('allow');
  });

  it('should filter audit logs by tenant_id', async () => {
    const { auditGuardrail, readAuditLogs } = await loadAudit();
    auditGuardrail({ tenantId: 't1', ruleId: 'r1', action: 'block', severity: 'low' });
    auditGuardrail({ tenantId: 't2', ruleId: 'r2', action: 'block', severity: 'low' });

    const { logs } = readAuditLogs({ tenant_id: 't1' });
    expect(logs.every((l) => l.tenant_id === 't1')).toBe(true);
  });

  it('should filter audit logs by event_type', async () => {
    const { auditGuardrail, auditAdmin, readAuditLogs } = await loadAudit();
    auditGuardrail({ ruleId: 'r1', action: 'block', severity: 'low' });
    auditAdmin({ ruleId: 'admin.key_deleted', action: 'allow' });

    const { logs } = readAuditLogs({ event_type: 'admin.key_deleted' });
    expect(logs.length).toBe(1);
    expect(logs[0].event_type).toBe('admin.key_deleted');
  });

  it('should return empty logs when directory does not exist', async () => {
    const { readAuditLogs } = await loadAudit();
    rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    const result = readAuditLogs();
    expect(result.logs).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('should skip corrupted lines', async () => {
    const { readAuditLogs } = await loadAudit();
    const file = join(TEST_LOG_DIR, `audit-${new Date().toISOString().slice(0, 10)}.log`);
    writeFileSync(file, '{"valid":true}\nnot-json\n', 'utf-8');

    const { logs } = readAuditLogs();
    expect(logs.length).toBe(1);
  });
});
