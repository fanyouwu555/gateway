import type { IVectorStore, VectorSearchResult } from './vector-interface';

interface VectorEntry {
  id: string;
  vector: Float32Array;
  metadata: Record<string, unknown>;
  insertedAt: number;
}

interface MemoryVectorStoreOptions {
  maxEntries?: number;
}

export class MemoryVectorStore implements IVectorStore {
  private entries: VectorEntry[] = [];
  private readonly maxEntries: number;

  constructor(options: MemoryVectorStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10000;
  }

  async connect(): Promise<void> {
    // no-op for memory store
  }

  async search(
    vector: number[],
    topK: number,
    threshold: number,
    namespace: string
  ): Promise<VectorSearchResult[]> {
    const query = new Float32Array(vector);
    const results: VectorSearchResult[] = [];

    for (const entry of this.entries) {
      if (entry.metadata['namespace'] !== namespace) continue;

      const score = this.cosineSimilarity(query, entry.vector);
      if (score >= threshold) {
        results.push({ id: entry.id, score, metadata: entry.metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async insert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<void> {
    if (this.entries.length >= this.maxEntries) {
      this.entries.sort((a, b) => a.insertedAt - b.insertedAt);
      this.entries.shift();
    }

    this.entries.push({
      id,
      vector: new Float32Array(vector),
      metadata,
      insertedAt: Date.now(),
    });
  }

  async delete(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  count(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
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
