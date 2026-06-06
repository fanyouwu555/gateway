/**
 * Admin Pricing API Tests
 */
import { getPricingService } from '../../src/services/pricing';
import adminRouter from '../../src/routes/admin';

// Mock requireAdmin to skip auth for these unit tests
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((_c: any, next: any) => next()),
}));

describe('Admin Pricing API', () => {
  beforeEach(() => {
    getPricingService().initialize({
      'gpt-4o': { input: 2.5, output: 10 },
      'claude-3': { input: 15, output: 75 },
    });
  });

  afterEach(() => {
    getPricingService().resetOverrides();
  });

  it('GET /v1/pricing returns all prices and overrides', async () => {
    const res = await adminRouter.request('/v1/pricing');
    expect(res.status).toBe(200);
    const body = await res.json() as { prices: Record<string, unknown>; overrides: Record<string, unknown> };
    expect(body.prices['gpt-4o']).toEqual({ input: 2.5, output: 10 });
    expect(body.overrides).toEqual({});
  });

  it('PUT /v1/pricing/:model sets a runtime override', async () => {
    const res = await adminRouter.request('/v1/pricing/gpt-4o', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 3, output: 12 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string; input: number; output: number };
    expect(body.model).toBe('gpt-4o');
    expect(body.input).toBe(3);
    expect(body.output).toBe(12);
    expect(getPricingService().getPrice('gpt-4o')).toEqual({ input: 3, output: 12 });
  });

  it('PUT /v1/pricing/:model rejects negative values', async () => {
    const res = await adminRouter.request('/v1/pricing/gpt-4o', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: -1, output: 10 }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /v1/pricing/:model removes a runtime override', async () => {
    getPricingService().setPrice('gpt-4o', 3, 12);
    const res = await adminRouter.request('/v1/pricing/gpt-4o', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(getPricingService().getPrice('gpt-4o')).toEqual({ input: 2.5, output: 10 });
  });

  it('DELETE /v1/pricing/:model returns 404 for non-override', async () => {
    const res = await adminRouter.request('/v1/pricing/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});