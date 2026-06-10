import { createKVStore } from '../stores/factory';
import type { IKVStore } from '../stores/interface';

const PLUGIN_PREFIX = 'plugin:code:';
const PLUGIN_LIST_KEY = 'plugin:list';

export class PluginStore {
  private store: IKVStore;

  constructor() {
    this.store = createKVStore('plugins');
  }

  private async getStore(): Promise<IKVStore> {
    if (!this.store.isConnected()) {
      await this.store.connect();
    }
    return this.store;
  }

  async save(id: string, code: string): Promise<void> {
    const store = await this.getStore();
    await store.set(`${PLUGIN_PREFIX}${id}`, code);
    const list = await this.getList();
    if (!list.includes(id)) {
      list.push(id);
      await store.set(PLUGIN_LIST_KEY, JSON.stringify(list));
    }
  }

  async load(id: string): Promise<string | null> {
    const store = await this.getStore();
    const code = await store.get(`${PLUGIN_PREFIX}${id}`);
    return code || null;
  }

  async delete(id: string): Promise<void> {
    const store = await this.getStore();
    await store.delete(`${PLUGIN_PREFIX}${id}`);
    const list = await this.getList();
    const filtered = list.filter((p) => p !== id);
    await store.set(PLUGIN_LIST_KEY, JSON.stringify(filtered));
  }

  async list(): Promise<string[]> {
    return this.getList();
  }

  private async getList(): Promise<string[]> {
    const store = await this.getStore();
    const raw = await store.get(PLUGIN_LIST_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }
}

let globalPluginStore: PluginStore | null = null;

export function getPluginStore(): PluginStore {
  if (!globalPluginStore) {
    globalPluginStore = new PluginStore();
  }
  return globalPluginStore;
}

export function resetPluginStore(): void {
  globalPluginStore = null;
}
