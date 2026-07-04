/**
 * 请求日志服务测试
 */
import { reloadConfig } from '../../src/config';
import {
  RequestLogStore,
  resetRequestLogStore,
  getRequestLogStore,
} from '../../src/services/request-log';

describe('RequestLogStore', () => {
  beforeEach(() => {
    reloadConfig();
    const config = require('../../src/config').getConfig();
    config.request_logging = { enabled: true, sample_rate: 1.0, max_body_size: 20 };
    resetRequestLogStore();
  });

  afterEach(() => {
    resetRequestLogStore();
  });

  function makeLog(overrides: Partial<Parameters<RequestLogStore['add']>[0]> = {}) {
    return {
      request_id: 'req-1',
      tenant_id: 't1',
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/chat/completions',
      provider: 'openai',
      model: 'gpt-4o',
      status_code: 200,
      duration_ms: 100,
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      request_body: '{}',
      response_body: '{}',
      cost: 0.001,
      ...overrides,
    };
  }

  it('should not sample when disabled', () => {
    const config = require('../../src/config').getConfig();
    config.request_logging = { enabled: false };
    resetRequestLogStore();
    expect(getRequestLogStore().shouldSample()).toBe(false);
  });

  it('should sample based on sample rate', () => {
    const store = getRequestLogStore();
    const randomSpy = jest.spyOn(Math, 'random');
    randomSpy.mockReturnValue(0.3);
    expect(store.shouldSample()).toBe(true);

    randomSpy.mockReturnValue(1.5);
    expect(store.shouldSample()).toBe(false);

    randomSpy.mockRestore();
  });

  it('should add and retrieve logs', () => {
    const store = getRequestLogStore();
    store.add(makeLog({ request_id: 'req-1' }));
    store.add(makeLog({ request_id: 'req-2', tenant_id: 't2', model: 'claude-3' }));

    const logs = store.getLogs();
    expect(logs.length).toBe(2);
    expect(logs.map((l) => l.request_id)).toContain('req-1');
    expect(logs.map((l) => l.request_id)).toContain('req-2');
  });

  it('should truncate long bodies', () => {
    const store = getRequestLogStore();
    store.add(makeLog({ request_body: 'a'.repeat(100) }));

    const logs = store.getLogs();
    expect(logs[0].request_body).toMatch(/\.\.\. \[truncated\]$/);
  });

  it('should filter logs by tenant_id', () => {
    const store = getRequestLogStore();
    store.add(makeLog({ tenant_id: 't1' }));
    store.add(makeLog({ tenant_id: 't2' }));

    expect(store.getLogs({ tenant_id: 't1' }).length).toBe(1);
  });

  it('should filter logs by model and status_code', () => {
    const store = getRequestLogStore();
    store.add(makeLog({ model: 'gpt-4o', status_code: 200 }));
    store.add(makeLog({ model: 'claude-3', status_code: 500 }));

    expect(store.getLogs({ model: 'gpt-4o' }).length).toBe(1);
    expect(store.getLogs({ status_code: 500 }).length).toBe(1);
  });

  it('should filter logs by time range', () => {
    const store = getRequestLogStore();
    const now = Date.now();
    store.add(makeLog({ timestamp: now - 1000 }));
    store.add(makeLog({ timestamp: now + 1000 }));

    expect(store.getLogs({ start: now - 500 }).length).toBe(1);
    expect(store.getLogs({ end: now + 500 }).length).toBe(1);
  });

  it('should support pagination', () => {
    const store = getRequestLogStore();
    store.add(makeLog({ request_id: 'req-1', timestamp: 1 }));
    store.add(makeLog({ request_id: 'req-2', timestamp: 2 }));
    store.add(makeLog({ request_id: 'req-3', timestamp: 3 }));

    const page = store.getLogs({ limit: 2, offset: 1 });
    expect(page.length).toBe(2);
  });

  it('should sort logs by timestamp descending', () => {
    const store = getRequestLogStore();
    store.add(makeLog({ request_id: 'req-1', timestamp: 1000 }));
    store.add(makeLog({ request_id: 'req-2', timestamp: 3000 }));
    store.add(makeLog({ request_id: 'req-3', timestamp: 2000 }));

    const logs = store.getLogs();
    expect(logs[0].request_id).toBe('req-2');
    expect(logs[1].request_id).toBe('req-3');
    expect(logs[2].request_id).toBe('req-1');
  });

  it('should enforce max size (ring buffer)', () => {
    const store = getRequestLogStore();
    for (let i = 0; i < 1100; i++) {
      store.add(makeLog({ request_id: `req-${i}`, timestamp: i }));
    }
    expect(store.getTotalCount()).toBe(1000);
  });

  it('should clear logs', () => {
    const store = getRequestLogStore();
    store.add(makeLog());
    store.clear();
    expect(store.getTotalCount()).toBe(0);
    expect(store.getLogs()).toEqual([]);
  });
});
