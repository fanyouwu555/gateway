/**
 * WalletStore concurrent deduction tests
 */
import { resetWalletStore, setBalance, deductBalance, getBalance } from '../../src/services/wallet';

describe('WalletStore concurrent deduction', () => {
  beforeEach(() => {
    resetWalletStore();
  });

  it('should deduct correctly under concurrent requests', async () => {
    const keyHash = 'test-key-hash';
    setBalance(keyHash, 1500); // 1500 micro-yuan

    const promises = Array.from({ length: 10 }, () =>
      deductBalance(keyHash, 150)
    );
    const results = await Promise.all(promises);

    const totalDeducted = results.reduce((sum, r) => {
      return sum + (r.success ? 150 : 0);
    }, 0);

    const finalBalance = getBalance(keyHash);
    expect(finalBalance).toBe(1500 - totalDeducted);
    expect(finalBalance).toBeGreaterThanOrEqual(0);
  });

  it('should not overdraft below zero', async () => {
    const keyHash = 'test-key-hash-2';
    setBalance(keyHash, 100);

    const promises = Array.from({ length: 5 }, () =>
      deductBalance(keyHash, 50)
    );
    await Promise.all(promises);

    const finalBalance = getBalance(keyHash);
    expect(finalBalance).toBeGreaterThanOrEqual(0);
  });
});
