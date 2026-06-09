import { createHash } from 'crypto';
import { writeLog } from '../utils/logger';
import { createEmbedding as createProviderEmbedding } from '../providers';

const EMBEDDING_ENABLED = process.env.EMBEDDING_ENABLED !== 'false';
const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || 'openai';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

// Local memoization cache: text hash -> vector
const embeddingCache = new Map<string, { vector: number[]; expiresAt: number }>();
const EMBEDDING_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_TEXT_LENGTH_FOR_HASH = 8000;

// Singleflight: deduplicate concurrent in-flight embedding requests
const inflightEmbeddings = new Map<string, Promise<number[] | null>>();

function getCacheKey(text: string): string {
  const keyText = text.length > MAX_TEXT_LENGTH_FOR_HASH
    ? text.slice(0, MAX_TEXT_LENGTH_FOR_HASH) + createHash('sha256').update(text).digest('hex').slice(0, 16)
    : text;
  return createHash('sha256').update(keyText).digest('hex');
}

function cleanEmbeddingCache(): void {
  const now = Date.now();
  for (const [key, entry] of embeddingCache.entries()) {
    if (now > entry.expiresAt) {
      embeddingCache.delete(key);
    }
  }
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  if (!EMBEDDING_ENABLED) return null;
  if (!text || text.trim().length === 0) return null;

  const cacheKey = getCacheKey(text);
  const cached = embeddingCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.vector;
  }

  // Singleflight: deduplicate concurrent in-flight requests
  const inflight = inflightEmbeddings.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const promise = fetchEmbedding(text, cacheKey);
  inflightEmbeddings.set(cacheKey, promise);

  promise.finally(() => {
    inflightEmbeddings.delete(cacheKey);
  });

  return promise;
}

async function fetchEmbedding(text: string, cacheKey: string): Promise<number[] | null> {
  try {
    const response = await createProviderEmbedding(EMBEDDING_PROVIDER, {
      model: EMBEDDING_MODEL,
      input: text,
    });

    if (!response?.data?.[0]?.embedding) {
      writeLog('warn', 'Embedding response missing data', { provider: EMBEDDING_PROVIDER });
      return null;
    }

    const vector = response.data[0].embedding as number[];

    cleanEmbeddingCache();
    embeddingCache.set(cacheKey, { vector, expiresAt: Date.now() + EMBEDDING_CACHE_TTL_MS });

    return vector;
  } catch (err) {
    writeLog('warn', 'Embedding request failed', {
      error: err instanceof Error ? err.message : String(err),
      provider: EMBEDDING_PROVIDER,
    });
    return null;
  }
}

export function resetEmbeddingCache(): void {
  embeddingCache.clear();
}
