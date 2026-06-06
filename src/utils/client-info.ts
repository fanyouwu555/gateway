/**
 * 客户端信息提取工具
 * 从请求头中提取标准化的客户端标识信息，兼容各种 IDE/客户端
 */

export interface ClientInfo {
  name: string;
  version?: string;
  inferredFrom: 'header' | 'user-agent' | 'unknown';
}

export interface SessionSource {
  id: string;
  providedByHeader?: string;
}

export interface ExtractedClientInfo {
  clientInfo: ClientInfo;
  sessionSource: SessionSource;
  userAgent: string;
}

/**
 * 从请求头中提取客户端信息和会话标识
 * 优先级：
 *   1. X-Client-Name / X-Session-Id（标准头）
 *   2. X-Session-Affinity（兼容 OpenCode）
 *   3. User-Agent 推断
 *   4. 自动生成 session ID
 */
export function extractClientInfo(headers: Headers): ExtractedClientInfo {
  const userAgent = headers.get('user-agent') || 'unknown';

  // 1. 提取客户端信息（优先自定义头，其次 UA 推断）
  const clientInfo = extractClientInfoFromHeaders(headers, userAgent);

  // 2. 提取会话 ID（按优先级：标准头 → 兼容头 → 自动生成）
  const sessionSource = extractSessionSource(headers);

  return { clientInfo, sessionSource, userAgent };
}

function extractClientInfoFromHeaders(headers: Headers, userAgent: string): ClientInfo {
  const clientNameHeader = headers.get('x-client-name');
  if (clientNameHeader) {
    return {
      name: clientNameHeader,
      version: headers.get('x-client-version') || undefined,
      inferredFrom: 'header',
    };
  }

  // 从 User-Agent 推断
  const inferred = inferClientFromUA(userAgent);
  return {
    name: inferred.name,
    version: inferred.version,
    inferredFrom: inferred.name !== 'unknown' ? 'user-agent' : 'unknown',
  };
}

function extractSessionSource(headers: Headers): SessionSource {
  const sessionHeaders: { key: string; value: string | null }[] = [
    { key: 'x-session-id', value: headers.get('x-session-id') },
    { key: 'x-session-affinity', value: headers.get('x-session-affinity') },
  ];

  const matched = sessionHeaders.find((h) => h.value);
  if (matched) {
    return {
      id: matched.value!,
      providedByHeader: matched.key,
    };
  }

  return {
    id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  };
}

/**
 * 从 User-Agent 字符串推断客户端信息
 * 支持常见 IDE、工具和浏览器
 */
function inferClientFromUA(ua: string): { name: string; version?: string } {
  if (ua.includes('opencode/')) {
    const m = ua.match(/opencode\/([\d.]+)/);
    return { name: 'opencode', version: m?.[1] };
  }
  if (ua.includes('Cursor/')) {
    const m = ua.match(/Cursor\/([\d.]+)/);
    return { name: 'cursor', version: m?.[1] };
  }
  if (ua.includes('Trae/')) {
    const m = ua.match(/Trae\/([\d.]+)/);
    return { name: 'trae', version: m?.[1] };
  }
  if (ua.includes('VSCode/')) {
    const m = ua.match(/VSCode\/([\d.]+)/);
    return { name: 'vscode', version: m?.[1] };
  }
  if (ua.includes('IntelliJ') || ua.includes('JetBrains')) {
    return { name: 'jetbrains', version: undefined };
  }
  if (ua.includes('curl/')) {
    const m = ua.match(/curl\/([\d.]+)/);
    return { name: 'curl', version: m?.[1] };
  }
  if (ua.includes('python-requests')) {
    return { name: 'python', version: undefined };
  }
  if (ua.startsWith('Mozilla/')) {
    return { name: 'browser', version: undefined };
  }
  return { name: 'unknown', version: undefined };
}
