import { PluginStore } from '../../src/services/plugin-store';
import { resetStorageFactory } from '../../src/stores/factory';

describe('PluginStore', () => {
  let store: PluginStore;

  beforeEach(() => {
    resetStorageFactory();
    store = new PluginStore();
  });

  it('should save and load plugin code', async () => {
    const code = 'exports.config = { id: "test", name: "Test", type: "guardrail", enabled: true, priority: 1 }; exports.check = async () => ({ allowed: true });';
    await store.save('test', code);
    const loaded = await store.load('test');
    expect(loaded).toBe(code);
  });

  it('should list all saved plugins', async () => {
    await store.save('p1', 'code1');
    await store.save('p2', 'code2');
    const list = await store.list();
    expect(list).toContain('p1');
    expect(list).toContain('p2');
  });

  it('should delete plugin', async () => {
    await store.save('test', 'code');
    await store.delete('test');
    const loaded = await store.load('test');
    expect(loaded).toBeNull();
  });

  it('should return null for non-existent plugin', async () => {
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });
});
