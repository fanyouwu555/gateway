/**
 * Admin Audit Log API Tests
 */
import { createApp } from '../../src/app';
import type { Hono } from 'hono';
import { readAuditLogs } from '../../src/utils/audit';

jest.mock('../../src/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { hashApiKey } = require('../../src/utils');
  const adminKeyHash = hashApiKey('admin-dashboard-key-456');
  return {
    getConfig: jest.fn(() => ({
      port: 3000,
      host: '0.0.0.0',
      log_level: 'info',
      providers: {},
      routing: [],
      auth: {
        enabled: true,
        api_keys: [{
          key: adminKeyHash,
          tenant_id: 'default',
          name: 'Admin Key',
          created_at: Date.now(),
          is_admin: true,
        }],
      },
      rate_limit: { enabled: false, qps: 1000, burst: 1000 },
    })),
    getProviderConfig: jest.fn(() => ({ provider: 'openai', base_url: '', api_key: '' })),
    getProviderForModel: jest.fn(() => 'openai'),
    getRoutingStrategy: jest.fn(() => ({ name: 'default', rules: [] })),
    setConfig: jest.fn(),
    resolveModelAlias: jest.fn((m: string) => m),
    getProviderNames: jest.fn(() => []),
  };
});

jest.mock('../../src/utils/audit', () => ({
  ...jest.requireActual('../../src/utils/audit'),
  readAuditLogs: jest.fn().mockReturnValue({ logs: [], total: 0 }),
}));

describe('Admin Audit API', () => {
  let app: Hono;
  const mockReadAuditLogs = readAuditLogs as jest.Mock;

  beforeEach(() => {
    app = createApp();
    mockReadAuditLogs.mockReturnValue({
      logs: [
        {
          id: 'test-1',
          timestamp: new Date().toISOString(),
          event_type: 'guardrail.triggered',
          tenant_id: 'default',
          rule_id: 'pii-detection',
          action: 'block',
          severity: 'high',
        },
      ],
      total: 1,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return audit logs with admin key', async () => {
    const res = await app.request('/v1/audit/logs', {
      headers: { Authorization: 'Bearer admin-dashboard-key-456' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { logs: unknown[]; total: number };
    expect(body).toHaveProperty('logs');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.logs)).toBe(true);
    expect(body.total).toBe(1);
  });

  it('should pass query parameters to readAuditLogs', async () => {
    await app.request('/v1/audit/logs?tenant_id=default&event_type=guardrail.triggered&limit=10&offset=0', {
      headers: { Authorization: 'Bearer admin-dashboard-key-456' },
    });

    expect(mockReadAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'default',
        event_type: 'guardrail.triggered',
        limit: 10,
        offset: 0,
      })
    );
  });

  it('should require admin auth', async () => {
    const res = await app.request('/v1/audit/logs');
    expect(res.status).toBe(401);
  });

  it('should cap limit at 500', async () => {
    await app.request('/v1/audit/logs?limit=1000', {
      headers: { Authorization: 'Bearer admin-dashboard-key-456' },
    });

    expect(mockReadAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 500,
      })
    );
  });
});
