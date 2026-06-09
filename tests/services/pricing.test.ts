import { PricingService, getPricingService } from '../../src/services/pricing';

describe('PricingService', () => {
  let service: PricingService;

  beforeEach(() => {
    service = new PricingService();
  });

  describe('getPrice', () => {
    it('should return config price when model exists in config', () => {
      service.initialize({
        'gpt-4o': { input: 2.5, output: 10 },
      });
      const price = service.getPrice('gpt-4o');
      expect(price.input).toBe(2.5);
      expect(price.output).toBe(10);
    });

    it('should return override price when set', () => {
      service.initialize({ 'gpt-4o': { input: 2.5, output: 10 } });
      service.setPrice('gpt-4o', 3.0, 15);
      const price = service.getPrice('gpt-4o');
      expect(price.input).toBe(3.0);
      expect(price.output).toBe(15);
    });

    it('should fall back to __default__ when model not found', () => {
      service.initialize({ '__default__': { input: 1.0, output: 2.0 } });
      const price = service.getPrice('unknown-model');
      expect(price.input).toBe(1.0);
      expect(price.output).toBe(2.0);
    });

    it('should fall back to hardcoded defaults when no config', () => {
      service.initialize({});
      const price = service.getPrice('unknown-model');
      expect(price.input).toBe(30);
      expect(price.output).toBe(60);
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly for known model', () => {
      service.initialize({ 'gpt-4o': { input: 2.5, output: 10 } });
      // 1000 prompt + 500 completion tokens = (1000*2.5 + 500*10) / 1_000_000 = 0.0075
      const cost = service.calculateCost('gpt-4o', 1000, 500);
      expect(cost).toBe(0.0075);
    });
  });

  describe('deletePrice / resetOverrides', () => {
    it('should delete a specific override', () => {
      service.initialize({ 'gpt-4o': { input: 2.5, output: 10 } });
      service.setPrice('gpt-4o', 5, 20);
      expect(service.getPrice('gpt-4o').input).toBe(5);
      service.deletePrice('gpt-4o');
      expect(service.getPrice('gpt-4o').input).toBe(2.5);
    });

    it('should reset all overrides', () => {
      service.initialize({ 'gpt-4o': { input: 2.5, output: 10 } });
      service.setPrice('gpt-4o', 5, 20);
      service.setPrice('claude-3', 10, 50);
      service.resetOverrides();
      expect(service.getPrice('gpt-4o').input).toBe(2.5);
    });
  });

  describe('getAllPrices', () => {
    it('should merge config and overrides', () => {
      service.initialize({
        'gpt-4o': { input: 2.5, output: 10 },
        'claude-3': { input: 10, output: 50 },
      });
      service.setPrice('gpt-4o', 3, 12);
      const all = service.getAllPrices();
      expect(all['gpt-4o']).toEqual({ input: 3, output: 12 });
      expect(all['claude-3']).toEqual({ input: 10, output: 50 });
    });

    it('should not include __default__ in getAllPrices', () => {
      service.initialize({ '__default__': { input: 1, output: 2 } });
      const all = service.getAllPrices();
      expect(all['__default__']).toBeUndefined();
    });
  });
});

describe('getPricingService (singleton)', () => {
  it('should return the same instance', () => {
    const a = getPricingService();
    const b = getPricingService();
    expect(a).toBe(b);
  });
});