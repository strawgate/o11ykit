/**
 * In-memory fetch cache for GitHub raw content.
 * Avoids repeated requests when navigating between pages and re-mounting hooks.
 * Entries expire after TTL_MS (5 minutes).
 */

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  data: unknown;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

export function cachedFetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < TTL_MS) {
    return Promise.resolve(hit.data as T);
  }

  return fetch(url, { signal }).then(r => {
    if (!r.ok) throw new Error(`Fetch ${url}: ${r.status}`);
    return r.json() as Promise<T>;
  }).then(data => {
    cache.set(url, { data, ts: Date.now() });
    return data;
  });
}
