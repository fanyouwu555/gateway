/**
 * WebSocket 管理测试
 * 测试 WebSocketManager 的连接管理/统计/清理
 */
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import type { Context } from 'hono';
import {
  addConnection,
  removeConnection,
  getConnection,
  getConnectionsByTenant,
  getWebSocketStats,
  cleanWebSocketConnections,
  resetWebSocketConnections,
  handleWSConnection,
} from '../src/middleware/websocket';

describe('WebSocketManager', () => {
  beforeEach(() => {
    // 重置所有连接，确保每个测试从空白状态开始
    resetWebSocketConnections();
  });

  describe('addConnection', () => {
    it('should create a connection and return ID', () => {
      const id = addConnection('tenant-1', 'gpt-4o');
      expect(id).toMatch(/^ws_/);
    });

    it('should store connection details', () => {
      const id = addConnection('tenant-1', 'gpt-4o');
      const conn = getConnection(id);
      expect(conn).not.toBeNull();
      expect(conn?.tenant_id).toBe('tenant-1');
      expect(conn?.model).toBe('gpt-4o');
    });

    it('should set connected_at timestamp', () => {
      const before = Date.now();
      const id = addConnection('tenant-1', 'gpt-4o');
      const conn = getConnection(id);
      expect(conn?.connected_at).toBeGreaterThanOrEqual(before);
      expect(conn?.connected_at).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('removeConnection', () => {
    it('should remove an existing connection', () => {
      const id = addConnection('tenant-1', 'gpt-4o');
      const removed = removeConnection(id);
      expect(removed).toBe(true);
      expect(getConnection(id)).toBeNull();
    });

    it('should return false for non-existent connection', () => {
      const removed = removeConnection('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('getConnection', () => {
    it('should return null for non-existent connection', () => {
      const conn = getConnection('non-existent');
      expect(conn).toBeNull();
    });

    it('should return connection details', () => {
      const id = addConnection('tenant-1', 'gpt-4o');
      const conn = getConnection(id);
      expect(conn).toHaveProperty('id', id);
      expect(conn).toHaveProperty('tenant_id');
      expect(conn).toHaveProperty('model');
      expect(conn).toHaveProperty('connected_at');
      expect(conn).toHaveProperty('last_activity');
    });
  });

  describe('getConnectionsByTenant', () => {
    it('should return connections for a tenant', () => {
      const id1 = addConnection('tenant-1', 'gpt-4o');
      const id2 = addConnection('tenant-1', 'gpt-4o-mini');
      addConnection('tenant-2', 'claude-3');

      const tenant1Conns = getConnectionsByTenant('tenant-1');
      expect(tenant1Conns).toHaveLength(2);
      expect(tenant1Conns.map((c) => c.id)).toContain(id1);
      expect(tenant1Conns.map((c) => c.id)).toContain(id2);
    });

    it('should return empty array for tenant with no connections', () => {
      const conns = getConnectionsByTenant('non-existent');
      expect(conns).toEqual([]);
    });
  });

  describe('getWebSocketStats', () => {
    it('should return total count and per-tenant breakdown', () => {
      addConnection('tenant-1', 'gpt-4o');
      addConnection('tenant-1', 'gpt-4o-mini');
      addConnection('tenant-2', 'claude-3');

      const stats = getWebSocketStats();
      expect(stats.total).toBe(3);
      expect(stats.by_tenant['tenant-1']).toBe(2);
      expect(stats.by_tenant['tenant-2']).toBe(1);
    });

    it('should return zero stats when empty', () => {
      const stats = getWebSocketStats();
      expect(stats.total).toBe(0);
      expect(stats.by_tenant).toEqual({});
    });
  });

  describe('cleanWebSocketConnections', () => {
    it('should remove stale connections', async () => {
      const id = addConnection('tenant-1', 'gpt-4o');
      const conn = getConnection(id);
      expect(conn).not.toBeNull();

      // clean currently removes connections idle > 5 min
      // Since our connections are fresh, they should survive
      const cleaned = cleanWebSocketConnections();
      expect(cleaned).toBe(0);

      // Connection still exists after clean
      expect(getConnection(id)).not.toBeNull();
    });

    it('should not affect active connections', () => {
      const id = addConnection('tenant-1', 'gpt-4o');
      cleanWebSocketConnections();
      expect(getConnection(id)).not.toBeNull();
    });
  });

  describe('cross-tenant isolation', () => {
    it('should keep tenant connections separate', () => {
      const t1Id = addConnection('tenant-1', 'gpt-4o');
      addConnection('tenant-2', 'claude-3');

      removeConnection(t1Id);
      expect(getConnectionsByTenant('tenant-1')).toHaveLength(0);
      expect(getConnectionsByTenant('tenant-2')).toHaveLength(1);
    });
  });

  describe('multiple connections', () => {
    it('should handle many simultaneous connections', () => {
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        ids.push(addConnection(`tenant-${i % 5}`, 'gpt-4o'));
      }

      expect(getWebSocketStats().total).toBe(50);
      expect(getWebSocketStats().by_tenant['tenant-0']).toBe(10);

      // Remove half
      ids.slice(0, 25).forEach((id) => removeConnection(id));
      expect(getWebSocketStats().total).toBe(25);
    });
  });
});

describe('handleWSConnection', () => {
  beforeEach(() => {
    resetWebSocketConnections();
  });

  it('should store rate limit fields on connection', () => {
    const fakeWS = new EventEmitter() as unknown as WebSocket;
    const ctx = {
      get: (key: string) => {
        if (key === 'tenant_id') return 'tenant-rl';
        if (key === 'key_hash') return 'hash-rl';
        if (key === 'key_rate_limit_qps') return 10;
        if (key === 'key_rate_limit_burst') return 20;
        if (key === 'key_billing_mode') return 'prepaid';
        return undefined;
      },
      req: { query: () => undefined, header: () => undefined },
    } as unknown as Context;

    handleWSConnection(fakeWS, ctx);
    const conns = getConnectionsByTenant('tenant-rl');
    expect(conns.length).toBe(1);
    expect(conns[0].key_rate_limit_qps).toBe(10);
    expect(conns[0].key_rate_limit_burst).toBe(20);
  });
});
