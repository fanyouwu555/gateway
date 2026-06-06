/**
 * Prompt 模板服务
 * 支持模板变量替换和预设模板
 */
import type { ChatMessage } from '../types';

/**
 * 模板定义
 */
export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  template: string;
  variables: string[];
  default_values?: Record<string, string>;
  created_at: number;
  updated_at: number;
}

/**
 * 模板存储
 */
class TemplateStore {
  private templates = new Map<string, PromptTemplate>();

  constructor() {
    // 初始化预设模板
    this.initDefaults();
  }

  /**
   * 初始化预设模板
   */
  private initDefaults(): void {
    // 翻译模板
    this.create({
      id: 'translate',
      name: '翻译助手',
      description: '将文本翻译成指定语言',
      template: '请将以下内容翻译成{{target_language}}：\n\n{{content}}',
      variables: ['target_language', 'content'],
    });

    // 总结模板
    this.create({
      id: 'summarize',
      name: '文本总结',
      description: '将长文本总结为简洁摘要',
      template: '请用{{max_length}}字以内总结以下内容：\n\n{{content}}',
      variables: ['max_length', 'content'],
      default_values: { max_length: '200' },
    });

    // 代码审查模板
    this.create({
      id: 'code-review',
      name: '代码审查',
      description: '审查代码并提供改进建议',
      template: '请审查以下代码并提供改进建议：\n\n```{{language}}\n{{code}}\n```',
      variables: ['language', 'code'],
    });

    // 问答模板
    this.create({
      id: 'qa',
      name: '问答助手',
      description: '基于上下文回答问题',
      template: '基于以下上下文：\n\n{{context}}\n\n回答问题：{{question}}',
      variables: ['context', 'question'],
    });
  }

  /**
   * 创建模板
   */
  create(template: Omit<PromptTemplate, 'created_at' | 'updated_at'>): PromptTemplate {
    const now = Date.now();
    const newTemplate: PromptTemplate = {
      ...template,
      created_at: now,
      updated_at: now,
    };
    this.templates.set(template.id, newTemplate);
    return newTemplate;
  }

  /**
   * 获取模板
   */
  get(id: string): PromptTemplate | null {
    return this.templates.get(id) || null;
  }

  /**
   * 获取所有模板
   */
  list(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * 更新模板
   */
  update(id: string, updates: Partial<Omit<PromptTemplate, 'id' | 'created_at'>>): PromptTemplate | null {
    const template = this.templates.get(id);
    if (!template) return null;

    const updated: PromptTemplate = {
      ...template,
      ...updates,
      updated_at: Date.now(),
    };
    this.templates.set(id, updated);
    return updated;
  }

  /**
   * 删除模板
   */
  delete(id: string): boolean {
    return this.templates.delete(id);
  }
}

// 单例
const templateStore = new TemplateStore();

/**
 * 渲染模板
 */
export function renderTemplate(
  templateId: string,
  variables: Record<string, string>
): string | null {
  const template = templateStore.get(templateId);
  if (!template) return null;

  let result = template.template;

  // 替换变量
  for (const varName of template.variables) {
    const value = variables[varName] || template.default_values?.[varName] || '';
    const regex = new RegExp(`\\{\\{${varName}\\}\\}`, 'g');
    result = result.replace(regex, value);
  }

  return result;
}

/**
 * 从模板生成消息
 */
export function templateToMessages(
  templateId: string,
  variables: Record<string, string>
): ChatMessage[] | null {
  const rendered = renderTemplate(templateId, variables);
  if (!rendered) return null;

  return [
    {
      role: 'user',
      content: rendered,
    },
  ];
}

/**
 * 获取模板
 */
export function getTemplate(id: string): PromptTemplate | null {
  return templateStore.get(id);
}

/**
 * 列出所有模板
 */
export function listTemplates(): PromptTemplate[] {
  return templateStore.list();
}

/**
 * 更新模板
 */
export function updateTemplate(
  id: string,
  updates: Partial<Omit<PromptTemplate, 'id' | 'created_at'>>
): PromptTemplate | null {
  return templateStore.update(id, updates);
}

/**
 * 删除模板
 */
export function deleteTemplate(id: string): boolean {
  return templateStore.delete(id);
}

/**
 * 创建自定义模板
 */
export function createTemplate(
  template: Omit<PromptTemplate, 'created_at' | 'updated_at'>
): PromptTemplate {
  return templateStore.create(template);
}

/**
 * 解析模板变量
 */
export function parseTemplate(template: string): string[] {
  const regex = /\{\{(\w+)\}\}/g;
  const variables: string[] = [];
  let match;

  while ((match = regex.exec(template)) !== null) {
    if (!variables.includes(match[1])) {
      variables.push(match[1]);
    }
  }

  return variables;
}

/**
 * 验证模板变量
 */
export function validateVariables(
  template: string,
  variables: Record<string, string>
): { valid: boolean; missing?: string[]; extra?: string[] } {
  const defined = parseTemplate(template);
  const provided = Object.keys(variables);
  const missing: string[] = [];
  const extra: string[] = [];

  // 检查缺失
  for (const v of defined) {
    if (!variables[v] && !v.startsWith('default_')) {
      missing.push(v);
    }
  }

  // 检查多余
  for (const v of provided) {
    if (!defined.includes(v)) {
      extra.push(v);
    }
  }

  return {
    valid: missing.length === 0,
    missing: missing.length > 0 ? missing : undefined,
    extra: extra.length > 0 ? extra : undefined,
  };
}