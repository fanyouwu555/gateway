/**
 * WalletService 单元测试
 */
import {
  getBalance,
  setBalance,
  checkPrepaidBalance,
  deductBalance,
  rechargeBalance,
  getTransactions,
  resetWalletStore,
} from '../../src/services/wallet';

describe('WalletService', () => {
  beforeEach(() => {
    resetWalletStore();
  });

  describe('getBalance / setBalance', () => {
    it('should return 0 for unknown keys', () => {
      expect(getBalance('unknown-key')).toBe(0);
    });

    it('should round-trip balance correctly', () => {
      setBalance('key-1', 5_000_000);
      expect(getBalance('key-1')).toBe(5_000_000);
    });

    it('should not allow negative balances', () => {
      setBalance('key-1', -100);
      expect(getBalance('key-1')).toBe(0);
    });
  });

  describe('checkPrepaidBalance', () => {
    it('should allow when balance is positive', () => {
      setBalance('key-1', 1_000_000);
      const result = checkPrepaidBalance('key-1');
      expect(result.allowed).toBe(true);
      expect(result.current_balance_micro_yuan).toBe(1_000_000);
    });

    it('should reject when balance is 0', () => {
      setBalance('key-1', 0);
      const result = checkPrepaidBalance('key-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Insufficient');
    });

    it('should reject when estimated cost exceeds balance', () => {
      setBalance('key-1', 100);
      const result = checkPrepaidBalance('key-1', 200);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('estimated cost');
    });
  });

  describe('rechargeBalance', () => {
    it('should increase balance and create transaction', () => {
      const result = rechargeBalance('key-1', 1_000_000, 'Test recharge');
      expect(result.success).toBe(true);
      expect(result.new_balance_micro_yuan).toBe(1_000_000);
      expect(result.transaction.type).toBe('recharge');
      expect(result.transaction.amount_micro_yuan).toBe(1_000_000);
      expect(result.transaction.reason).toBe('Test recharge');
      expect(getBalance('key-1')).toBe(1_000_000);
    });

    it('should accumulate balance on multiple recharges', () => {
      rechargeBalance('key-1', 500_000);
      rechargeBalance('key-1', 300_000);
      expect(getBalance('key-1')).toBe(800_000);
    });
  });

  describe('deductBalance', () => {
    it('should succeed when balance is sufficient', () => {
      setBalance('key-1', 1_000_000);
      const result = deductBalance('key-1', 300_000, { reason: 'test' });
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(700_000);
      expect(result.transaction.type).toBe('deduct');
      expect(result.transaction.amount_micro_yuan).toBe(-300_000);
      expect(result.transaction.balance_after_micro_yuan).toBe(700_000);
    });

    it('should fail and drain to 0 when balance is insufficient', () => {
      setBalance('key-1', 200_000);
      const result = deductBalance('key-1', 500_000);
      expect(result.success).toBe(false);
      expect(result.newBalance).toBe(0);
      expect(getBalance('key-1')).toBe(0);
    });

    it('should record transaction even on overdraft', () => {
      setBalance('key-1', 100_000);
      deductBalance('key-1', 500_000);
      const txs = getTransactions('key-1');
      expect(txs.length).toBe(1);
      expect(txs[0].type).toBe('deduct');
    });
  });

  describe('getTransactions', () => {
    it('should return transactions newest-first', () => {
      rechargeBalance('key-1', 100_000, 'first');
      rechargeBalance('key-1', 200_000, 'second');
      const txs = getTransactions('key-1');
      expect(txs.length).toBe(2);
      expect(txs[0].reason).toBe('second');
      expect(txs[1].reason).toBe('first');
    });

    it('should respect limit', () => {
      for (let i = 0; i < 5; i++) {
        rechargeBalance('key-1', 10_000);
      }
      expect(getTransactions('key-1', 3).length).toBe(3);
      expect(getTransactions('key-1', 10).length).toBe(5);
    });

    it('should return empty array for unknown key', () => {
      expect(getTransactions('unknown-key')).toEqual([]);
    });
  });
});
