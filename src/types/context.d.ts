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
    key_hash: string;
    key_rate_limit_qps: number | undefined;
    key_rate_limit_burst: number | undefined;
    key_metadata: Record<string, string> | undefined;
    key_allowed_models: string[] | undefined;
    key_monthly_budget: number | undefined;
    key_max_tokens_per_request: number | undefined;
    key_billing_mode: 'competition' | 'subscription' | 'prepaid' | undefined;
    key_balance_micro_yuan: number | undefined;
    key_subscription_expires_at: number | undefined;
  }
}