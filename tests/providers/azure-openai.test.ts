import { AzureOpenAIProvider } from '../../src/providers/azure-openai';

describe('AzureOpenAIProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should build correct URL', () => {
    process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.AZURE_OPENAI_API_KEY = 'test-key';

    const provider = new AzureOpenAIProvider();
    const url = (provider as unknown as { buildAzureUrl: (path: string) => string }).buildAzureUrl('/chat/completions');
    expect(url).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01');
  });

  it('should use api-key header', () => {
    process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.AZURE_OPENAI_API_KEY = 'test-key';

    const provider = new AzureOpenAIProvider();
    const headers = (provider as unknown as { buildAzureHeaders: () => Record<string, string> }).buildAzureHeaders();
    expect(headers['api-key']).toBe('test-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('should use custom api version', () => {
    process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    process.env.AZURE_OPENAI_API_VERSION = '2024-06-01';

    const provider = new AzureOpenAIProvider();
    const url = (provider as unknown as { buildAzureUrl: (path: string) => string }).buildAzureUrl('/embeddings');
    expect(url).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o/embeddings?api-version=2024-06-01');
  });
});
