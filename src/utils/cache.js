/**
 * Lightweight in-process TTL cache.
 * Suitable for expensive read-only DB queries on mostly-static data.
 */
const store = new Map()

/**
 * Returns cached value if fresh, otherwise calls `fn`, caches the result, and returns it.
 * @param {string} key
 * @param {number} ttlMs  Time-to-live in milliseconds
 * @param {() => Promise<any>} fn  Async factory function
 */
export async function cached(key, ttlMs, fn) {
  const hit = store.get(key)
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value
  const value = await fn()
  store.set(key, { value, ts: Date.now() })
  return value
}

export function invalidate(key) {
  store.delete(key)
}

export function invalidatePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key)
  }
}
