import type { IVectorStore, VectorSearchResult } from './vector-interface';
import Redis from 'ioredis';
import { writeLog } from '../utils/logger';

interface RedisVectorStoreOptions {
  prefix?: string;
  maxEntries?: number;
  redis?: Redis;
}

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
  insertedAt: number;
}

export class RedisVectorStore implements IVectorStore {
  private redis: Redis;
  private readonly prefix: string;
  private readonly maxEntries: number;

  constructor(options: RedisVectorStoreOptions = {}) {
    this.prefix = options.prefix || 'gateway:vector';
    this.maxEntries = options.maxEntries ?? 10000;
    this.redis = options.redis || this.createRedisClient();
  }

  private createRedisClient(): Redis {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD;
    const db = parseInt(process.env.REDIS_DB || '0', 10);

    return new Redis({ host, port, password, db, lazyConnect: true });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async search(
    vector: number[],
    topK: number,
    threshold: number,
    namespace: string
  ): Promise<VectorSearchResult[]> {
    const entries = await this.loadAllEntries();
    const query = new Float32Array(vector);
    const results: VectorSearchResult[] = [];

    for (const entry of entries) {
      if (entry.metadata['namespace'] !== namespace) continue;

      const score = this.cosineSimilarity(query, new Float32Array(entry.vector));
      if (score >= threshold) {
        results.push({ id: entry.id, score, metadata: entry.metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async insert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<void> {
    await this.enforceMaxEntries();

    const entry: VectorEntry = {
      id,
      vector,
      metadata,
      insertedAt: Date.now(),
    };

    await this.redis.hset(this.hashKey, id, JSON.stringify(entry));
  }

  async delete(id: string): Promise<void> {
    await this.redis.hdel(this.hashKey, id);
  }

  count(): number {
    return 0;
  }

  clear(): void {
    this.redis.del(this.hashKey).catch((e: Error) => {
      writeLog('warn', 'Failed to clear Redis vector store', { error: e.message });
    });
  }

  private get hashKey(): string {
    return `${this.prefix}:entries`;
  }

  private async loadAllEntries(): Promise<VectorEntry[]> {
    const data = await this.redis.hgetall(this.hashKey);
    const entries: VectorEntry[] = [];

    for (const value of Object.values(data)) {
      try {
        entries.push(JSON.parse(value) as VectorEntry);
      } catch {
        // skip corrupted entries
      }
    }

    return entries;
  }

  private async enforceMaxEntries(): Promise<void> {
    const count = await this.redis.hlen(this.hashKey);
    if (count >= this.maxEntries) {
      const data = await this.redis.hgetall(this.hashKey);
      let oldestId = '';
      let oldestTime = Infinity;

      for (const [id, value] of Object.entries(data)) {
        try {
          const entry = JSON.parse(value) as VectorEntry;
          if (entry.insertedAt < oldestTime) {
            oldestTime = entry.insertedAt;
            oldestId = id;
          }
        } catch {
          // skip corrupted
        }
      }

      if (oldestId) {
        await this.redis.hdel(this.hashKey, oldestId);
      }
    }
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
