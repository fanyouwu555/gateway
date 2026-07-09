/**
 * Wallet Redis 持久化测试
 * 使用 MemoryKVStore 模拟 Redis 行为，验证 flush/load 流程
 */
import type { MemoryKVStore } from '../../src/stores/memory';

let sharedStore: MemoryKVStore;

jest.mock('../../src/utils', () => ({
  ...jest.requireActual('../../src/utils'),
  shouldUseRedis: jest.fn(() => true),
}));

jest.mock('../../src/stores/factory', () => ({
  createKVStore: jest.fn(() => {
    if (!sharedStore) {
      const { MemoryKVStore } = jest.requireActual('../../src/stores/memory');
      sharedStore = new MemoryKVStore('wallet');
    }
    return sharedStore;
  }),
}));

import {
  resetWalletStore,
  initWalletStore,
  flushWalletStore,
  setBalance,
  getBalance,
  rechargeBalance,
  deductBalance,
} from '../../src/services/wallet';

describe('Wallet Redis Persistence', () => {
  beforeEach(async () => {
    if (sharedStore) {
      await sharedStore.disconnect();
      sharedStore = undefined as unknown as MemoryKVStore;
    }
    resetWalletStore();
  });

  it('should persist balances to store on flush', async () => {
    setBalance('key1', 1_000_000);
    await rechargeBalance('key1', 500_000);

    await flushWalletStore();

    const storedValue = await sharedStore.get('balance:key1');
    expect(storedValue).toBe('1500000');
  });

  it('should restore balances from store on init', async () => {
    // 直接写入 store 模拟 Redis 已有数据
    await sharedStore.set('balance:key1', '8000000');

    // 重新初始化 WalletStore（模拟重启）
    resetWalletStore();
    await initWalletStore();

    expect(getBalance('key1')).toBe(8_000_000);
  });

  it('should persist multiple keys independently', async () => {
    setBalance('key-a', 1_000_000);
    setBalance('key-b', 2_000_000);
    await flushWalletStore();

    const valA = await sharedStore.get('balance:key-a');
    const valB = await sharedStore.get('balance:key-b');
    expect(valA).toBe('1000000');
    expect(valB).toBe('2000000');
  });

  it('should restore multiple keys on init', async () => {
    await sharedStore.set('balance:key-a', '3000000');
    await sharedStore.set('balance:key-b', '7000000');

    resetWalletStore();
    await initWalletStore();

    expect(getBalance('key-a')).toBe(3_000_000);
    expect(getBalance('key-b')).toBe(7_000_000);
  });

  it('should persist transactions to store', async () => {
    await rechargeBalance('key1', 1_000_000, 'Initial');
    await deductBalance('key1', 300_000, { reason: 'usage' });

    await flushWalletStore();

    const txs = await sharedStore.lRange('transactions:key1', 0, -1);
    expect(txs.length).toBe(2);

    const firstTx = JSON.parse(txs[0]);
    expect(firstTx.type).toBe('deduct');
    expect(firstTx.amount_micro_yuan).toBe(-300_000);

    const secondTx = JSON.parse(txs[1]);
    expect(secondTx.type).toBe('recharge');
    expect(secondTx.amount_micro_yuan).toBe(1_000_000);
  });

  it('should keep only max 1000 transactions per key', async () => {
    for (let i = 0; i < 1005; i++) {
      await rechargeBalance('key1', 1000);
    }

    await flushWalletStore();

    const txs = await sharedStore.lRange('transactions:key1', 0, -1);
    expect(txs.length).toBe(1000);
  });

  it('should handle scrypt key hash with colons correctly', async () => {
    // scrypt hash format: $scrypt$salt:hash
    const scryptKey = '$scrypt$abc123:def456';
    await sharedStore.set(`balance:${scryptKey}`, '4200000');

    resetWalletStore();
    await initWalletStore();

    expect(getBalance(scryptKey)).toBe(4_200_000);
  });
});
