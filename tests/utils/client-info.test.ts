/**
 * 客户端信息提取工具测试
 */
import { extractClientInfo } from '../../src/utils/client-info';

function makeHeaders(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('extractClientInfo', () => {
  it('should extract client from x-client-name header', () => {
    const info = extractClientInfo(makeHeaders({
      'x-client-name': 'my-client',
      'x-client-version': '1.2.3',
    }));
    expect(info.clientInfo).toEqual({
      name: 'my-client',
      version: '1.2.3',
      inferredFrom: 'header',
    });
  });

  it('should fallback to unknown when no recognizable info', () => {
    const info = extractClientInfo(makeHeaders({}));
    expect(info.clientInfo).toEqual({
      name: 'unknown',
      version: undefined,
      inferredFrom: 'unknown',
    });
    expect(info.userAgent).toBe('unknown');
  });

  it.each([
    ['opencode/1.0.0', 'opencode', '1.0.0'],
    ['Cursor/1.2.3', 'cursor', '1.2.3'],
    ['Trae/2.0.0', 'trae', '2.0.0'],
    ['VSCode/1.85.0', 'vscode', '1.85.0'],
    ['JetBrains IDE', 'jetbrains', undefined],
    ['curl/8.0.0', 'curl', '8.0.0'],
    ['python-requests/2.0', 'python', undefined],
    ['Mozilla/5.0 (Windows NT 10.0)', 'browser', undefined],
  ])('should infer client from User-Agent "%s"', (ua, name, version) => {
    const info = extractClientInfo(makeHeaders({ 'user-agent': ua }));
    expect(info.clientInfo).toEqual({ name, version, inferredFrom: name === 'unknown' ? 'unknown' : 'user-agent' });
  });

  it('should prefer x-client-name over user-agent', () => {
    const info = extractClientInfo(makeHeaders({
      'x-client-name': 'custom',
      'user-agent': 'Mozilla/5.0',
    }));
    expect(info.clientInfo.name).toBe('custom');
    expect(info.clientInfo.inferredFrom).toBe('header');
  });

  it('should extract session id from x-session-id', () => {
    const info = extractClientInfo(makeHeaders({ 'x-session-id': 'sess-123' }));
    expect(info.sessionSource).toEqual({
      id: 'sess-123',
      providedByHeader: 'x-session-id',
    });
  });

  it('should fallback to x-session-affinity', () => {
    const info = extractClientInfo(makeHeaders({ 'x-session-affinity': 'aff-456' }));
    expect(info.sessionSource).toEqual({
      id: 'aff-456',
      providedByHeader: 'x-session-affinity',
    });
  });

  it('should generate session id when no header present', () => {
    const info = extractClientInfo(makeHeaders({}));
    expect(info.sessionSource.providedByHeader).toBeUndefined();
    expect(info.sessionSource.id).toMatch(/^sess_\d+_[a-z0-9]+$/);
  });
});
