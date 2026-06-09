/**
 * Hono Context 类型扩展
 */
import type { TenantId, RequestId } from './index';

declare module 'hono' {
  interface ContextVariableMap {
    tenant_id: TenantId;
    api_key: string;
    api_key_meta: import('./index').IApiKeyMeta | undefined;
    request_id: RequestId;
    provider: string;
    model: string;
  }
}