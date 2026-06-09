import type { ChatCompletionRequest } from '../types';
import type { IVectorStore } from '../stores/vector-interface';
import { MemoryVectorStore } from '../stores/vector-memory';
import { RedisVectorStore } from '../stores/redis-vector';
import { getEmbedding } from './embedding';
import { writeLog } from '../utils/logger';

interface SemanticCacheOptions {
  vectorStore?: IVectorStore;
  threshold?: number;
  enabled?: boolean;
  maxMessages?: number;
}

function extractQueryText(request: ChatCompletionRequest): string {
  return request.messages.map((m) => m.content).join('\n');
}

function buildNamespace(request: ChatCompletionRequest, tenantId?: string): string {
  return `${tenantId || 'default'}:${request.model}`;
}

export class SemanticCacheService {
  private vectorStore: IVectorStore;
  private threshold: number;
  private enabled: boolean;
  private maxMessages: number;

  constructor(options: SemanticCacheOptions = {}) {
    this.vectorStore = options.vectorStore || new MemoryVectorStore();
    this.threshold = options.threshold ?? 0.85;
    this.enabled = options.enabled ?? false;
    this.maxMessages = options.maxMessages ?? 3;
  }

  isInitialized(): boolean {
    return this.enabled;
  }

  async findSimilar(request: ChatCompletionRequest, tenantId?: string): Promise<string | null> {
    if (!this.enabled) return null;
    if (request.stream) return null;
    if (request.messages.length > this.maxMessages) return null;

    const text = extractQueryText(request);
    const vector = await getEmbedding(text);
    if (!vector) return null;

    const namespace = buildNamespace(request, tenantId);
    const results = await this.vectorStore.search(vector, 1, this.threshold, namespace);

    if (results.length > 0) {
      writeLog('debug', 'Vector semantic cache hit', { score: results[0].score, namespace });
      const response = results[0].metadata?.['response'] as string | undefined;
      if (response) {
        return response;
      }
    }

    return null;
  }

  async storeEmbedding(request: ChatCompletionRequest, response: string, tenantId?: string): Promise<void> {
    if (!this.enabled) return;
    if (request.stream) return;
    if (request.messages.length > this.maxMessages) return;

    const text = extractQueryText(request);
    const vector = await getEmbedding(text);
    if (!vector) return;

    const namespace = buildNamespace(request, tenantId);
    const cacheKey = this.generateCacheKey(request, tenantId);

    await this.vectorStore.insert(cacheKey, vector, {
      namespace,
      model: request.model,
      response,
      createdAt: Date.now(),
    });
  }

  clear(): void {
    this.vectorStore.clear();
  }

  private generateCacheKey(request: ChatCompletionRequest, tenantId?: string): string {
    const parts = [
      tenantId || 'default',
      request.model,
      JSON.stringify(request.messages),
    ];
    return parts.join('|');
  }
}

let globalSemanticCache: SemanticCacheService | null = null;

export function initSemanticCache(config?: { enabled?: boolean; threshold?: number; backend?: string; max_entries?: number }): void {
  const maxEntries = config?.max_entries ?? 10000;
  let vectorStore: IVectorStore;

  if (config?.backend === 'redis_vector') {
    vectorStore = new RedisVectorStore({ maxEntries });
  } else {
    vectorStore = new MemoryVectorStore({ maxEntries });
  }

  globalSemanticCache = new SemanticCacheService({
    enabled: config?.enabled ?? false,
    threshold: config?.threshold ?? 0.85,
    vectorStore,
  });
}

export function getSemanticCache(): SemanticCacheService | null {
  return globalSemanticCache;
}
