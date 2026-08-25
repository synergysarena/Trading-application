/**
 * Generic key-value cache abstraction (Phase 8, Step 2).
 *
 * Deliberately Redis-agnostic — MarketDataCacheService is built against this
 * interface, not against a concrete implementation. MemoryCache below is the
 * only implementation today; a future RedisCache<T> implementing the same
 * interface is a drop-in replacement with zero changes required in any
 * consumer (MarketDataCacheService, or anything reading through it).
 */
export interface CacheStore<T> {
  set(key: string, value: T): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  remove(key: string): boolean;
  clear(): void;
  values(): T[];
  keys(): string[];
}

/** In-memory implementation backed by a Map. */
export class MemoryCache<T> implements CacheStore<T> {
  private store = new Map<string, T>();

  set(key: string, value: T): void {
    this.store.set(key, value);
  }

  get(key: string): T | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  remove(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  values(): T[] {
    return Array.from(this.store.values());
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }
}
