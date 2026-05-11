/**
 * Prompt 模板服务测试
 */
import {
  renderTemplate,
  templateToMessages,
  getTemplate,
  listTemplates,
  createTemplate,
  deleteTemplate,
  parseTemplate,
  validateVariables,
} from '../services/prompt';

describe('Prompt Service', () => {
  describe('listTemplates', () => {
    it('should return default templates', () => {
      const templates = listTemplates();
      expect(templates.length).toBeGreaterThan(0);
      expect(templates.some((t) => t.id === 'translate')).toBe(true);
      expect(templates.some((t) => t.id === 'summarize')).toBe(true);
    });
  });

  describe('getTemplate', () => {
    it('should return template by ID', () => {
      const template = getTemplate('translate');
      expect(template).not.toBeNull();
      expect(template?.name).toBe('翻译助手');
    });

    it('should return null for non-existent template', () => {
      const template = getTemplate('non-existent');
      expect(template).toBeNull();
    });
  });

  describe('renderTemplate', () => {
    it('should render template with variables', () => {
      const result = renderTemplate('translate', {
        target_language: 'Japanese',
        content: 'Hello world',
      });
      expect(result).toContain('Japanese');
      expect(result).toContain('Hello world');
    });

    it('should use default values', () => {
      const result = renderTemplate('summarize', {
        content: 'Long text here',
      });
      expect(result).toContain('200'); // default max_length
    });

    it('should return null for non-existent template', () => {
      const result = renderTemplate('non-existent', {});
      expect(result).toBeNull();
    });
  });

  describe('templateToMessages', () => {
    it('should convert template to messages', () => {
      const messages = templateToMessages('translate', {
        target_language: 'Chinese',
        content: 'Test',
      });
      expect(messages).not.toBeNull();
      expect(messages).toHaveLength(1);
      expect(messages?.[0].role).toBe('user');
      expect(messages?.[0].content).toContain('Chinese');
    });
  });

  describe('createTemplate', () => {
    it('should create custom template', () => {
      const template = createTemplate({
        id: 'custom-test',
        name: 'Custom Template',
        description: 'A custom template',
        template: 'Hello {{name}}',
        variables: ['name'],
      });
      expect(template.id).toBe('custom-test');
    });
  });

  describe('deleteTemplate', () => {
    it('should delete template', () => {
      const deleted = deleteTemplate('custom-test');
      expect(deleted).toBe(true);

      // 再次删除应该失败
      const deletedAgain = deleteTemplate('custom-test');
      expect(deletedAgain).toBe(false);
    });
  });

  describe('parseTemplate', () => {
    it('should extract variables from template', () => {
      const variables = parseTemplate('Hello {{name}}, you are {{age}} years old');
      expect(variables).toContain('name');
      expect(variables).toContain('age');
    });

    it('should not duplicate variables', () => {
      const variables = parseTemplate('{{name}} is {{name}}');
      expect(variables).toEqual(['name']);
    });
  });

  describe('validateVariables', () => {
    it('should validate valid variables', () => {
      const result = validateVariables('Hello {{name}}', { name: 'John' });
      expect(result.valid).toBe(true);
      expect(result.missing).toBeUndefined();
    });

    it('should detect missing variables', () => {
      const result = validateVariables('Hello {{name}} and {{age}}', { name: 'John' });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('age');
    });

    it('should detect extra variables but still be valid', () => {
      const result = validateVariables('Hello {{name}}', { name: 'John', age: '30' });
      // 当前实现只检查缺失，不检查额外变量
      expect(result.valid).toBe(true);
      expect(result.extra).toContain('age');
    });
  });
});