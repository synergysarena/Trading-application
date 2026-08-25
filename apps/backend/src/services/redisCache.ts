import { CacheStore } from "./cacheStore";
import { getRedisClient } from "./redisService";

/**
 * Redis-backed implementation of the CacheStore<T> interface from Phase 8
 * (cacheStore.ts) — proves the abstraction holds: any consumer built against
 * CacheStore<T> (e.g. MarketDataCacheService) could swap MemoryCache<T> for
 * RedisCache<T> with zero code changes, exactly as promised when the
 * interface was introduced.
 *
 * CacheStore<T>'s methods are synchronous by contract ("Do NOT change the
 * interface" — Phase 10, Step 1), but Redis is inherently a network call.
 * This class resolves that the same way redisWriteBuffer.ts already does
 * elsewhere in this codebase: an in-memory mirror is the synchronous source
 * of truth for every interface method (get/has/values/keys/remove/clear all
 * answer instantly and correctly), while set() additionally fires a
 * best-effort, non-blocking write to Redis for durability across restarts.
 * hydrate() (not part of the interface — an extra capability specific to
 * this implementation) can load previously-persisted keys back into the
 * mirror once, typically at startup.
 */
export class RedisCache<T> implements CacheStore<T> {
  private mirror = new Map<string, T>();

  constructor(private readonly namespace: string) {}

  private redisKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  set(key: string, value: T): void {
    this.mirror.set(key, value);

    const client = getRedisClient();
    if (!client) return; // degrade silently — the mirror is still correct, just not durable right now

    client.set(this.redisKey(key), JSON.stringify(value)).catch((err: any) => {
      console.error(`[RedisCache:${this.namespace}] Best-effort persist failed for "${key}":`, err?.message || err);
    });
  }

  get(key: string): T | undefined {
    return this.mirror.get(key);
  }

  has(key: string): boolean {
    return this.mirror.has(key);
  }

  remove(key: string): boolean {
    const existed = this.mirror.delete(key);

    const client = getRedisClient();
    if (client) {
      client.del(this.redisKey(key)).catch((err: any) => {
        console.error(`[RedisCache:${this.namespace}] Best-effort delete failed for "${key}":`, err?.message || err);
      });
    }
    return existed;
  }

  clear(): void {
    this.mirror.clear();
    // Deliberately does not sweep Redis — this namespace may hold many keys and a
    // full scan+delete would spend commands well beyond what "clear the local
    // cache" implies. Use deleteInstrumentHistory-style targeted deletes for that.
  }

  values(): T[] {
    return Array.from(this.mirror.values());
  }

  keys(): string[] {
    return Array.from(this.mirror.keys());
  }

  /**
   * Loads a previously-persisted value back into the in-memory mirror.
   * Not part of CacheStore<T> — an extra capability for callers that want to
   * warm the mirror from Redis (e.g. once at startup) without every get()
   * paying for a network round trip.
   */
  async hydrate(key: string): Promise<T | undefined> {
    const client = getRedisClient();
    if (!client) return this.mirror.get(key);

    try {
      const raw = await (client as any).get(this.redisKey(key));
      if (raw === null || raw === undefined) return this.mirror.get(key);
      const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
      this.mirror.set(key, value);
      return value;
    } catch (err: any) {
      console.error(`[RedisCache:${this.namespace}] hydrate failed for "${key}":`, err?.message || err);
      return this.mirror.get(key);
    }
  }
}
