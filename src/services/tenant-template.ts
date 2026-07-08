import type { ITenantTemplate } from '../types';
import { generateRequestId, shouldUseRedis } from '../utils';
import { writeLog } from '../utils/logger';
import { createKVStore } from '../stores/factory';

type TenantTemplateUpdate = Omit<Partial<Omit<ITenantTemplate, 'template_id' | 'created_at'>>, 'tenant' | 'default_key'> & {
  tenant?: Partial<ITenantTemplate['tenant']>;
  default_key?: Partial<NonNullable<ITenantTemplate['default_key']>>;
};

class TenantTemplateStore {
  private templates = new Map<string, ITenantTemplate>();
  private useRedis = false;
  private store: ReturnType<typeof createKVStore> | null = null;

  constructor() {
    this.useRedis = shouldUseRedis('TENANT_STORAGE'); // 与 tenant 共用开关，或新增 TENANT_TEMPLATE_STORAGE
  }

  private async getStore(): Promise<ReturnType<typeof createKVStore>> {
    if (!this.store) {
      this.store = createKVStore('tenant-template');
    }
    if (!this.store.isConnected()) {
      await this.store.connect();
    }
    return this.store;
  }

  private async persist(templateId: string): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const template = this.templates.get(templateId);
      if (template) {
        await store.set(`tenant-template:data:${templateId}`, JSON.stringify(template));
      }
    } catch {
      // 持久化失败不影响主流程
    }
  }

  private async removeFromStorage(templateId: string): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      await store.delete(`tenant-template:data:${templateId}`);
    } catch {
      // 删除失败不影响主流程
    }
  }

  async loadFromStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const keys = await store.keys('tenant-template:data:*');
      for (const key of keys) {
        const templateId = key.replace('tenant-template:data:', '');
        const data = await store.get(key);
        if (data) {
          try {
            const template = JSON.parse(data) as ITenantTemplate;
            this.templates.set(templateId, template);
          } catch {
            // 忽略解析失败的条目
          }
        }
      }
      writeLog('info', 'Tenant templates loaded from Redis', { count: keys.length });
    } catch (err) {
      writeLog('warn', 'Failed to load tenant templates from Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async flushToStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      for (const [templateId, template] of this.templates.entries()) {
        await store.set(`tenant-template:data:${templateId}`, JSON.stringify(template));
      }
    } catch (err) {
      writeLog('warn', 'Failed to flush tenant templates to Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  create(template: Omit<ITenantTemplate, 'template_id' | 'created_at' | 'updated_at'>): ITenantTemplate {
    const templateId = `tpl_${generateRequestId()}`;
    const now = Date.now();
    const newTemplate: ITenantTemplate = {
      ...template,
      template_id: templateId,
      created_at: now,
      updated_at: now,
    };
    this.templates.set(templateId, newTemplate);
    this.persist(templateId);
    return newTemplate;
  }

  get(templateId: string): ITenantTemplate | null {
    return this.templates.get(templateId) || null;
  }

  async update(templateId: string, updates: TenantTemplateUpdate): Promise<ITenantTemplate | null> {
    const template = this.templates.get(templateId);
    if (!template) return null;

    const updated: ITenantTemplate = {
      ...template,
      ...updates,
      tenant: updates.tenant ? { ...template.tenant, ...updates.tenant } : template.tenant,
      default_key: updates.default_key ? { ...(template.default_key ?? {}), ...updates.default_key } : template.default_key,
      updated_at: Date.now(),
    };
    this.templates.set(templateId, updated);
    await this.persist(templateId);
    return updated;
  }

  async delete(templateId: string): Promise<boolean> {
    const deleted = this.templates.delete(templateId);
    if (deleted) {
      await this.removeFromStorage(templateId);
    }
    return deleted;
  }

  list(): ITenantTemplate[] {
    return Array.from(this.templates.values());
  }

  getDefault(): ITenantTemplate | null {
    for (const template of this.templates.values()) {
      if (template.is_default) {
        return template;
      }
    }
    return null;
  }
}

let store = new TenantTemplateStore();

export function resetTenantTemplateStore(): void {
  store = new TenantTemplateStore();
}

export async function initTenantTemplateStore(): Promise<void> {
  await store.loadFromStorage();
}

export async function flushTenantTemplateStore(): Promise<void> {
  await store.flushToStorage();
}

export function createTenantTemplate(template: Omit<ITenantTemplate, 'template_id' | 'created_at' | 'updated_at'>): ITenantTemplate {
  return store.create(template);
}

export function getTenantTemplate(templateId: string): ITenantTemplate | null {
  return store.get(templateId);
}

export async function updateTenantTemplate(
  templateId: string,
  updates: TenantTemplateUpdate
): Promise<ITenantTemplate | null> {
  return store.update(templateId, updates);
}

export async function deleteTenantTemplate(templateId: string): Promise<boolean> {
  return store.delete(templateId);
}

export function listTenantTemplates(): ITenantTemplate[] {
  return store.list();
}

export function getDefaultTenantTemplate(): ITenantTemplate | null {
  return store.getDefault();
}
