/**
 * Plugin Loader Tests
 * Verify VM sandbox isolation and plugin loading
 */
import { loadPluginInSandbox } from '../../src/plugins/loader';
import { registerPlugin, unregisterPlugin, resetPluginManager, listPlugins } from '../../src/plugins';

describe('Plugin Loader', () => {
  beforeEach(() => {
    resetPluginManager();
  });

  describe('sandbox isolation', () => {
    it('should reject code trying to access require', () => {
      const code = `
        const fs = require('fs');
        module.exports = {};
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(false);
      expect(result.error).toContain('require');
    });

    it('should reject code trying to access process', () => {
      const code = `
        const env = process.env;
        module.exports = {};
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(false);
      expect(result.error).toContain('process');
    });

    it('should allow basic math and JSON operations', () => {
      const code = `
        const data = JSON.stringify({ ok: true });
        const parsed = JSON.parse(data);
        module.exports = {
          config: {
            id: 'test-math',
            name: 'Test Math',
            type: 'guardrail',
            enabled: true,
            priority: 1,
          },
          check: async function(c, data) {
            return { allowed: parsed.ok };
          }
        };
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(true);
      expect(result.plugin).toBeDefined();
    });
  });

  describe('plugin validation', () => {
    it('should reject plugin without config', () => {
      const code = `
        module.exports = {
          check: async function() { return { allowed: true }; }
        };
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(false);
      expect(result.error).toContain('config');
    });

    it('should reject guardrail plugin without check function', () => {
      const code = `
        module.exports = {
          config: {
            id: 'test-guardrail',
            name: 'Test Guardrail',
            type: 'guardrail',
            enabled: true,
            priority: 1,
          }
        };
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(false);
      expect(result.error).toContain('check');
    });

    it('should reject request plugin without onRequest function', () => {
      const code = `
        module.exports = {
          config: {
            id: 'test-request',
            name: 'Test Request',
            type: 'request',
            enabled: true,
            priority: 1,
          }
        };
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(false);
      expect(result.error).toContain('onRequest');
    });

    it('should reject invalid plugin type', () => {
      const code = `
        module.exports = {
          config: {
            id: 'test-invalid',
            name: 'Test Invalid',
            type: 'unknown',
            enabled: true,
            priority: 1,
          },
          check: async function() { return { allowed: true }; }
        };
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(false);
      expect(result.error).toContain('type');
    });
  });

  describe('guardrail plugin loading', () => {
    it('should load and register a valid guardrail plugin', () => {
      const code = `
        module.exports = {
          config: {
            id: 'sensitive-test',
            name: 'Sensitive Test',
            type: 'guardrail',
            enabled: true,
            priority: 10,
          },
          check: async function(c, data) {
            if (data && data.messages) {
              for (const msg of data.messages) {
                if (msg.content && msg.content.includes('badword')) {
                  return { allowed: false, reason: 'Bad word detected' };
                }
              }
            }
            return { allowed: true };
          }
        };
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(true);
      expect(result.plugin).toBeDefined();

      registerPlugin(result.plugin!);
      const plugins = listPlugins();
      expect(plugins.some((p) => p.id === 'sensitive-test')).toBe(true);
    });
  });

  describe('request plugin loading', () => {
    it('should load a valid request plugin', () => {
      const code = `
        module.exports = {
          config: {
            id: 'request-test',
            name: 'Request Test',
            type: 'request',
            enabled: true,
            priority: 5,
          },
          onRequest: async function(c, request) {
            request.temperature = 0.5;
            return request;
          }
        };
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(true);
      expect(result.plugin).toBeDefined();
    });
  });

  describe('plugin registration lifecycle', () => {
    it('should register and unregister a plugin', () => {
      const code = `
        module.exports = {
          config: {
            id: 'lifecycle-test',
            name: 'Lifecycle Test',
            type: 'guardrail',
            enabled: true,
            priority: 1,
          },
          check: async function() { return { allowed: true }; }
        };
      `;
      const result = loadPluginInSandbox(code);
      expect(result.success).toBe(true);

      registerPlugin(result.plugin!);
      expect(listPlugins().length).toBe(1);

      unregisterPlugin('lifecycle-test');
      expect(listPlugins().length).toBe(0);
    });
  });
});
