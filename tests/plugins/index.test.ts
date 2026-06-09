/**
 * Plugin system tests for src/plugins/index.ts
 */
import type { Context } from 'hono';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../../src/types';
import {
  registerPlugin,
  unregisterPlugin,
  resetPluginManager,
  runRequestPlugins,
  runResponsePlugins,
  runGuardrailPlugins,
  runTransformPlugins,
  listPlugins,
  setPluginEnabled,
  createSensitiveWordFilterPlugin,
} from '../../src/plugins';

const mockWriteLog = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  writeLog: (...args: unknown[]) => mockWriteLog(...args),
}));

jest.mock('node:fs', () => ({
  readFileSync: jest.fn(),
  existsSync: jest.fn(),
}));

jest.mock('node:vm', () => ({
  runInNewContext: jest.fn(),
}));

function createMockContext(): Context {
  return {} as unknown as Context;
}

describe('Plugin System', () => {
  beforeEach(() => {
    resetPluginManager();
    jest.clearAllMocks();
  });

  describe('registerPlugin', () => {
    it('should register a valid request plugin', () => {
      const plugin = {
        config: { id: 'req-1', name: 'Request Plugin', type: 'request' as const, enabled: true, priority: 10 },
        async onRequest(_c: Context, request: ChatCompletionRequest) {
          return request;
        },
      };
      registerPlugin(plugin);
      expect(listPlugins()).toHaveLength(1);
      expect(listPlugins()[0].id).toBe('req-1');
    });

    it('should register a valid guardrail plugin', () => {
      const plugin = {
        config: { id: 'guard-1', name: 'Guardrail', type: 'guardrail' as const, enabled: true, priority: 5 },
        async check(_c: Context, _data: unknown) {
          return { allowed: true };
        },
      };
      registerPlugin(plugin);
      expect(listPlugins()).toHaveLength(1);
    });

    it('should register multiple plugins', () => {
      const reqPlugin = {
        config: { id: 'req-1', name: 'Req', type: 'request' as const, enabled: true, priority: 10 },
        async onRequest(_c: Context, request: ChatCompletionRequest) { return request; },
      };
      const resPlugin = {
        config: { id: 'res-1', name: 'Res', type: 'response' as const, enabled: true, priority: 5 },
        async onResponse(_c: Context, response: ChatCompletionResponse) { return response; },
      };
      registerPlugin(reqPlugin);
      registerPlugin(resPlugin);
      expect(listPlugins()).toHaveLength(2);
    });
  });

  describe('executeGuardrails', () => {
    it('should allow when no guardrail plugins are registered', async () => {
      const result = await runGuardrailPlugins(createMockContext(), { messages: [] });
      expect(result.allowed).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('should allow when all guardrail plugins pass', async () => {
      const plugin = {
        config: { id: 'guard-pass', name: 'Pass Guard', type: 'guardrail' as const, enabled: true, priority: 10 },
        async check(_c: Context, _data: unknown) {
          return { allowed: true };
        },
      };
      registerPlugin(plugin);
      const result = await runGuardrailPlugins(createMockContext(), { messages: [{ content: 'hello' }] });
      expect(result.allowed).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('should block when a guardrail plugin rejects', async () => {
      const plugin = {
        config: { id: 'guard-block', name: 'Block Guard', type: 'guardrail' as const, enabled: true, priority: 10 },
        async check(_c: Context, _data: unknown) {
          return { allowed: false, reason: 'Blocked by policy' };
        },
      };
      registerPlugin(plugin);
      const result = await runGuardrailPlugins(createMockContext(), { messages: [{ content: 'bad' }] });
      expect(result.allowed).toBe(false);
      expect(result.reasons).toContain('[Block Guard] Blocked by policy');
    });

    it('should skip disabled guardrail plugins', async () => {
      const plugin = {
        config: { id: 'guard-disabled', name: 'Disabled Guard', type: 'guardrail' as const, enabled: false, priority: 10 },
        async check(_c: Context, _data: unknown) {
          return { allowed: false, reason: 'Should not run' };
        },
      };
      registerPlugin(plugin);
      const result = await runGuardrailPlugins(createMockContext(), { messages: [{ content: 'test' }] });
      expect(result.allowed).toBe(true);
    });

    it('should aggregate reasons from multiple blocking plugins', async () => {
      const plugin1 = {
        config: { id: 'g1', name: 'G1', type: 'guardrail' as const, enabled: true, priority: 10 },
        async check(_c: Context, _data: unknown) {
          return { allowed: false, reason: 'Reason one' };
        },
      };
      const plugin2 = {
        config: { id: 'g2', name: 'G2', type: 'guardrail' as const, enabled: true, priority: 5 },
        async check(_c: Context, _data: unknown) {
          return { allowed: false, reason: 'Reason two' };
        },
      };
      registerPlugin(plugin1);
      registerPlugin(plugin2);
      const result = await runGuardrailPlugins(createMockContext(), { messages: [{ content: 'test' }] });
      expect(result.allowed).toBe(false);
      expect(result.reasons).toContain('[G1] Reason one');
      expect(result.reasons).toContain('[G2] Reason two');
    });
  });

  describe('executeRequestPlugins', () => {
    it('should return original request when no request plugins are registered', async () => {
      const request: ChatCompletionRequest = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
      const result = await runRequestPlugins(createMockContext(), request);
      expect(result).toEqual(request);
    });

    it('should modify request through request plugins', async () => {
      const plugin = {
        config: { id: 'req-mod', name: 'Modifier', type: 'request' as const, enabled: true, priority: 10 },
        async onRequest(_c: Context, request: ChatCompletionRequest) {
          return { ...request, temperature: 0.5 };
        },
      };
      registerPlugin(plugin);
      const request: ChatCompletionRequest = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
      const result = await runRequestPlugins(createMockContext(), request);
      expect(result.temperature).toBe(0.5);
    });

    it('should skip plugins that return null', async () => {
      const plugin = {
        config: { id: 'req-null', name: 'Nullifier', type: 'request' as const, enabled: true, priority: 10 },
        async onRequest(_c: Context, _request: ChatCompletionRequest) {
          return null;
        },
      };
      registerPlugin(plugin);
      const request: ChatCompletionRequest = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
      const result = await runRequestPlugins(createMockContext(), request);
      expect(result).toEqual(request);
    });

    it('should skip disabled request plugins', async () => {
      const plugin = {
        config: { id: 'req-disabled', name: 'Disabled', type: 'request' as const, enabled: false, priority: 10 },
        async onRequest(_c: Context, request: ChatCompletionRequest) {
          return { ...request, temperature: 0.9 };
        },
      };
      registerPlugin(plugin);
      const request: ChatCompletionRequest = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
      const result = await runRequestPlugins(createMockContext(), request);
      expect(result.temperature).toBeUndefined();
    });

    it('should handle plugin errors gracefully', async () => {
      const plugin = {
        config: { id: 'req-err', name: 'Error', type: 'request' as const, enabled: true, priority: 10 },
        async onRequest(_c: Context, _request: ChatCompletionRequest) {
          throw new Error('plugin failure');
        },
      };
      registerPlugin(plugin);
      const request: ChatCompletionRequest = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
      const result = await runRequestPlugins(createMockContext(), request);
      expect(result).toEqual(request);
      expect(mockWriteLog).toHaveBeenCalledWith(
        'error',
        'Request plugin error',
        expect.objectContaining({ plugin_id: 'req-err' })
      );
    });
  });

  describe('executeResponsePlugins', () => {
    it('should return original response when no response plugins are registered', async () => {
      const response: ChatCompletionResponse = {
        id: 'r1',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      const result = await runResponsePlugins(createMockContext(), response);
      expect(result).toEqual(response);
    });

    it('should modify response through response plugins', async () => {
      const plugin = {
        config: { id: 'res-mod', name: 'ResModifier', type: 'response' as const, enabled: true, priority: 10 },
        async onResponse(_c: Context, response: ChatCompletionResponse) {
          return {
            ...response,
            choices: response.choices.map((c) => ({ ...c, message: { ...c.message, content: 'modified' } })),
          };
        },
      };
      registerPlugin(plugin);
      const response: ChatCompletionResponse = {
        id: 'r1',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      const result = await runResponsePlugins(createMockContext(), response);
      expect(result.choices[0].message.content).toBe('modified');
    });

    it('should handle response plugin errors gracefully', async () => {
      const plugin = {
        config: { id: 'res-err', name: 'ResError', type: 'response' as const, enabled: true, priority: 10 },
        async onResponse(_c: Context, _response: ChatCompletionResponse) {
          throw new Error('response plugin failure');
        },
      };
      registerPlugin(plugin);
      const response: ChatCompletionResponse = {
        id: 'r1',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      const result = await runResponsePlugins(createMockContext(), response);
      expect(result).toEqual(response);
      expect(mockWriteLog).toHaveBeenCalledWith(
        'error',
        'Response plugin error',
        expect.objectContaining({ plugin_id: 'res-err' })
      );
    });
  });

  describe('runTransformPlugins', () => {
    it('should return original data when no transform plugins are registered', async () => {
      const data = { foo: 'bar' };
      const result = await runTransformPlugins(createMockContext(), data);
      expect(result).toEqual(data);
    });

    it('should transform data sequentially', async () => {
      const plugin = {
        config: { id: 'trans-1', name: 'Transformer', type: 'transform' as const, enabled: true, priority: 10 },
        async transform(_c: Context, data: unknown) {
          return { ...(data as Record<string, unknown>), transformed: true };
        },
      };
      registerPlugin(plugin);
      const result = await runTransformPlugins(createMockContext(), { original: true });
      expect(result).toEqual({ original: true, transformed: true });
    });
  });

  describe('getRegisteredPlugins', () => {
    it('should return empty list initially', () => {
      expect(listPlugins()).toHaveLength(0);
    });

    it('should return registered plugin configs', () => {
      const plugin = {
        config: { id: 'p1', name: 'Plugin 1', type: 'request' as const, enabled: true, priority: 10 },
        async onRequest(_c: Context, request: ChatCompletionRequest) { return request; },
      };
      registerPlugin(plugin);
      const plugins = listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].id).toBe('p1');
    });
  });

  describe('setPluginEnabled', () => {
    it('should enable and disable a plugin', () => {
      const plugin = {
        config: { id: 'toggle', name: 'Toggle', type: 'request' as const, enabled: true, priority: 10 },
        async onRequest(_c: Context, request: ChatCompletionRequest) { return request; },
      };
      registerPlugin(plugin);
      expect(setPluginEnabled('toggle', false)).toBe(true);
      expect(listPlugins()[0].enabled).toBe(false);
      expect(setPluginEnabled('toggle', true)).toBe(true);
      expect(listPlugins()[0].enabled).toBe(true);
    });

    it('should return false for unknown plugin', () => {
      expect(setPluginEnabled('unknown', false)).toBe(false);
    });
  });

  describe('unregisterPlugin', () => {
    it('should remove a registered plugin', () => {
      const plugin = {
        config: { id: 'removable', name: 'Removable', type: 'request' as const, enabled: true, priority: 10 },
        async onRequest(_c: Context, request: ChatCompletionRequest) { return request; },
      };
      registerPlugin(plugin);
      expect(unregisterPlugin('removable')).toBe(true);
      expect(listPlugins()).toHaveLength(0);
    });

    it('should return false for non-existent plugin', () => {
      expect(unregisterPlugin('non-existent')).toBe(false);
    });
  });

  describe('createSensitiveWordFilterPlugin', () => {
    it('should allow messages without sensitive words', async () => {
      const plugin = createSensitiveWordFilterPlugin(['badword']);
      registerPlugin(plugin);
      const result = await runGuardrailPlugins(createMockContext(), { messages: [{ content: 'hello world' }] });
      expect(result.allowed).toBe(true);
    });

    it('should block messages containing sensitive words', async () => {
      const plugin = createSensitiveWordFilterPlugin(['badword']);
      registerPlugin(plugin);
      const result = await runGuardrailPlugins(createMockContext(), { messages: [{ content: 'this has badword in it' }] });
      expect(result.allowed).toBe(false);
      expect(result.reasons.some((r) => r.includes('badword'))).toBe(true);
    });

    it('should allow non-object data', async () => {
      const plugin = createSensitiveWordFilterPlugin(['badword']);
      registerPlugin(plugin);
      const result = await runGuardrailPlugins(createMockContext(), 'just a string');
      expect(result.allowed).toBe(true);
    });

    it('should allow data without messages', async () => {
      const plugin = createSensitiveWordFilterPlugin(['badword']);
      registerPlugin(plugin);
      const result = await runGuardrailPlugins(createMockContext(), { foo: 'bar' });
      expect(result.allowed).toBe(true);
    });
  });

});

describe('loadExternalPlugin', () => {
  beforeEach(() => {
    resetPluginManager();
    jest.clearAllMocks();
  });

  it('success path is covered by loader.test.ts; here we test integration with registerPlugin', () => {
    // The actual vm/fs loading is tested in loader.test.ts.
    // We verify that the plugin manager can hold externally loaded plugins by simulating one.
    const externalPlugin = {
      config: { id: 'ext-1', name: 'External', type: 'guardrail' as const, enabled: true, priority: 5 },
      async check(_c: Context, _data: unknown) {
        return { allowed: true };
      },
    };
    registerPlugin(externalPlugin);
    expect(listPlugins().some((p) => p.id === 'ext-1')).toBe(true);
  });
});
