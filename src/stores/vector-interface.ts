export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface IVectorStore {
  connect(): Promise<void>;
  search(vector: number[], topK: number, threshold: number, namespace: string): Promise<VectorSearchResult[]>;
  insert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
  count(): number;
  clear(): void;
}
