// 运行期搜索缓存（进程内，10 分钟有效）——集中管理，便于统计与清理
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

export function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

export function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

export function cacheStats() {
  return { size: cache.size, ttlMinutes: Math.round(TTL_MS / 60000), maxEntries: MAX_ENTRIES };
}
