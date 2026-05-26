/**
 * RequestLogStore 测试
 */
import { RequestLogStore, resetRequestLogStore } from '../../src/services/request-log';
import { reloadConfig, getConfig } from '../../src/config';

describe('RequestLogStore', () => {
  let store: RequestLogStore;

  beforeEach(() => {
    reloadConfig();
    const config = getConfig();
    config.request_logging = { enabled: true, max_body_size: 4096, sample_rate: 1.0 };
    store = new RequestLogStore();
  });

  afterEach(() => {
    resetRequestLogStore();
  });

  it('should add and retrieve logs', () => {
    store.add({
      request_id: 'req-1',
      tenant_id: 'tenant-a',
      timestamp: 1000,
      method: 'POST',
      path: '/v1/chat/completions',
      provider: 'openai',
      model: 'gpt-4o',
      status_code: 200,
      duration_ms: 500,
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });

    const logs = store.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].request_id).toBe('req-1');
  });

  it('should filter by tenant_id', () => {
    store.add({ request_id: 'req-1', tenant_id: 'tenant-a', timestamp: 1000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });
    store.add({ request_id: 'req-2', tenant_id: 'tenant-b', timestamp: 2000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 200 });

    const logs = store.getLogs({ tenant_id: 'tenant-a' });
    expect(logs).toHaveLength(1);
    expect(logs[0].tenant_id).toBe('tenant-a');
  });

  it('should filter by model', () => {
    store.add({ request_id: 'req-1', tenant_id: 't1', timestamp: 1000, method: 'POST', path: '/v1/chat/completions', model: 'gpt-4o', status_code: 200, duration_ms: 100 });
    store.add({ request_id: 'req-2', tenant_id: 't1', timestamp: 2000, method: 'POST', path: '/v1/chat/completions', model: 'deepseek-chat', status_code: 200, duration_ms: 200 });

    const logs = store.getLogs({ model: 'gpt-4o' });
    expect(logs).toHaveLength(1);
  });

  it('should filter by status_code', () => {
    store.add({ request_id: 'req-1', tenant_id: 't1', timestamp: 1000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });
    store.add({ request_id: 'req-2', tenant_id: 't1', timestamp: 2000, method: 'POST', path: '/v1/chat/completions', status_code: 429, duration_ms: 50 });

    const logs = store.getLogs({ status_code: 429 });
    expect(logs).toHaveLength(1);
    expect(logs[0].status_code).toBe(429);
  });

  it('should filter by time range', () => {
    store.add({ request_id: 'req-1', tenant_id: 't1', timestamp: 1000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });
    store.add({ request_id: 'req-2', tenant_id: 't1', timestamp: 2000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });
    store.add({ request_id: 'req-3', tenant_id: 't1', timestamp: 3000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });

    const logs = store.getLogs({ start: 1500, end: 2500 });
    expect(logs).toHaveLength(1);
    expect(logs[0].request_id).toBe('req-2');
  });

  it('should sort logs by timestamp descending', () => {
    store.add({ request_id: 'req-1', tenant_id: 't1', timestamp: 1000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });
    store.add({ request_id: 'req-2', tenant_id: 't1', timestamp: 3000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });
    store.add({ request_id: 'req-3', tenant_id: 't1', timestamp: 2000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });

    const logs = store.getLogs();
    expect(logs[0].request_id).toBe('req-2');
    expect(logs[1].request_id).toBe('req-3');
    expect(logs[2].request_id).toBe('req-1');
  });

  it('should respect limit and offset', () => {
    for (let i = 1; i <= 10; i++) {
      store.add({ request_id: `req-${i}`, tenant_id: 't1', timestamp: i * 1000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });
    }

    const logs = store.getLogs({ limit: 3, offset: 2 });
    expect(logs).toHaveLength(3);
    // Sorted by timestamp desc: req-10, req-9, req-8, req-7, req-6...
    // Offset 2 → skip req-10, req-9 → start at req-8
    expect(logs[0].request_id).toBe('req-8');
    expect(logs[1].request_id).toBe('req-7');
    expect(logs[2].request_id).toBe('req-6');
  });

  it('should truncate large request bodies', () => {
    store.add({
      request_id: 'req-1',
      tenant_id: 't1',
      timestamp: 1000,
      method: 'POST',
      path: '/v1/chat/completions',
      status_code: 200,
      duration_ms: 100,
      request_body: 'x'.repeat(5000),
    });

    const logs = store.getLogs();
    expect(logs[0].request_body!.length).toBeLessThanOrEqual(4111); // 4096 + '... [truncated]'.length
    expect(logs[0].request_body).toContain('[truncated]');
  });

  it('should enforce max size (ring buffer)', () => {
    for (let i = 0; i < 1100; i++) {
      store.add({
        request_id: `req-${i}`,
        tenant_id: 't1',
        timestamp: i,
        method: 'POST',
        path: '/v1/chat/completions',
        status_code: 200,
        duration_ms: 100,
      });
    }

    expect(store.getTotalCount()).toBe(1000);
  });

  it('should not add logs when disabled', () => {
    const config = getConfig();
    config.request_logging!.enabled = false;
    const disabledStore = new RequestLogStore();

    disabledStore.add({
      request_id: 'req-1',
      tenant_id: 't1',
      timestamp: 1000,
      method: 'POST',
      path: '/v1/chat/completions',
      status_code: 200,
      duration_ms: 100,
    });

    expect(disabledStore.getTotalCount()).toBe(0);
  });

  it('should handle sample rate', () => {
    const config = getConfig();
    config.request_logging!.sample_rate = 0; // never sample
    const sampledStore = new RequestLogStore();

    const shouldSample = sampledStore.shouldSample();
    expect(shouldSample).toBe(false);
  });

  it('should clear all logs', () => {
    store.add({ request_id: 'req-1', tenant_id: 't1', timestamp: 1000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });
    store.clear();
    expect(store.getTotalCount()).toBe(0);
  });

  it('should report total count', () => {
    expect(store.getTotalCount()).toBe(0);
    store.add({ request_id: 'req-1', tenant_id: 't1', timestamp: 1000, method: 'POST', path: '/v1/chat/completions', status_code: 200, duration_ms: 100 });
    expect(store.getTotalCount()).toBe(1);
  });
});