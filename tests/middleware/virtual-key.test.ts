/**
 * 虚拟 Key 策略中间件测试
 */
import { Hono } from 'hono';
import { virtualKeyMiddleware } from '../../src/middleware/virtual-key';
import type { IApiKeyMeta } from '../../src/types';

function makeKeyMeta(
  partial: Omit<IApiKeyMeta, 'created_at'> & Partial<Pick<IApiKeyMeta, 'created_at'>>,
): IApiKeyMeta {
  return { created_at: Date.now(), ...partial } as IApiKeyMeta;
}

function buildApp(keyMeta?: IApiKeyMeta): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (keyMeta) {
      c.set('api_key_meta', keyMeta);
    }
    await next();
  });
  app.use('*', virtualKeyMiddleware);
  app.get('/test', (c) => {
    return c.json({
      key_hash: c.get('key_hash'),
      key_rate_limit_qps: c.get('key_rate_limit_qps'),
      key_rate_limit_burst: c.get('key_rate_limit_burst'),
      key_metadata: c.get('key_metadata'),
      key_allowed_models: c.get('key_allowed_models'),
      key_monthly_budget: c.get('key_monthly_budget'),
      key_max_tokens_per_request: c.get('key_max_tokens_per_request'),
    });
  });
  return app;
}

describe('virtualKeyMiddleware', () => {
  async function getBody(res: Response): Promise<Record<string, unknown>> {
    return res.json() as Promise<Record<string, unknown>>;
  }

  it('should pass through when no api_key_meta is set', async () => {
    const app = buildApp();
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await getBody(res);
    expect(body).toEqual({
      key_hash: undefined,
      key_rate_limit_qps: undefined,
      key_rate_limit_burst: undefined,
      key_metadata: undefined,
      key_allowed_models: undefined,
      key_monthly_budget: undefined,
      key_max_tokens_per_request: undefined,
    });
  });

  it('should set key_hash from api_key_meta', async () => {
    const app = buildApp(makeKeyMeta({ key: 'hashed-key-123', tenant_id: 'default', name: 'test' }));
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await getBody(res);
    expect(body.key_hash).toBe('hashed-key-123');
  });

  it('should set rate limit fields when present', async () => {
    const app = buildApp(
      makeKeyMeta({
        key: 'key',
        tenant_id: 'default',
        name: 'test',
        rate_limit_qps: 5,
        rate_limit_burst: 10,
      }),
    );
    const res = await app.request('/test');
    const body = await getBody(res);
    expect(body.key_rate_limit_qps).toBe(5);
    expect(body.key_rate_limit_burst).toBe(10);
  });

  it('should set metadata when present', async () => {
    const app = buildApp(
      makeKeyMeta({
        key: 'key',
        tenant_id: 'default',
        name: 'test',
        metadata: { team: 'platform' },
      }),
    );
    const res = await app.request('/test');
    const body = await getBody(res);
    expect(body.key_metadata).toEqual({ team: 'platform' });
  });

  it('should set chat policy fields when present', async () => {
    const app = buildApp(
      makeKeyMeta({
        key: 'key',
        tenant_id: 'default',
        name: 'test',
        allowed_models: ['gpt-4o'],
        monthly_budget: 100,
        max_tokens_per_request: 4096,
      }),
    );
    const res = await app.request('/test');
    const body = await getBody(res);
    expect(body.key_allowed_models).toEqual(['gpt-4o']);
    expect(body.key_monthly_budget).toBe(100);
    expect(body.key_max_tokens_per_request).toBe(4096);
  });
});
