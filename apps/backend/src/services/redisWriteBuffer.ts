import redis from "../config/redis";

// ── In-memory live store + minimal Redis persistence ─────────────────────────
//
// Phase 6 introduced this buffer to coalesce per-tick Redis writes into one
// pipelined flush every 500ms. That fixed the HTTP-connection OOM, but Upstash
// counts every command INSIDE a pipeline against the monthly quota — flushing
// ~100-700 dirty ltp:/oi: keys twice a second still burned millions of
// commands/month (the "max requests limit exceeded" incident).
//
// The redesign rests on one fact: every reader of ltp:/oi: keys runs in THIS
// process. Redis is therefore not a message bus here — it is only (a) a
// restart-warmup snapshot for a handful of keys and (b) durable storage for
// auth/config. So:
//
//   • `mirror` (in-memory Map) is the authoritative live store for ALL keys.
//     Readers use readLive() below — a mirror hit costs zero Redis commands.
//   • Only PERSISTED_KEYS (the keys actually read back after a restart) are
//     ever written to Redis: at most once per PERSIST_MIN_INTERVAL_MS each,
//     and only when the value actually changed.
//   • Every persisted market-data key is written with SETEX MARKET_TTL_SECONDS
//     (25h) — the exact Redis equivalent of MongoDB's 25h TTL index on
//     FuturesOHLC.bar_time. Yesterday's keys expire on their own; the next
//     trading day starts clean with no manual cleanup.
//
// Worst-case steady-state Redis write load: 4 keys/minute during market hours.

const FLUSH_INTERVAL_MS = 500;

/** 25 hours — mirrors the MongoDB TTL index (FuturesOHLCSchema, 90000s). */
export const MARKET_TTL_SECONDS = 90000;

/** Minimum interval between Redis persists of the same key. These keys exist
 *  only so a restarted server can warm up; sub-minute freshness is not needed. */
const PERSIST_MIN_INTERVAL_MS = 60_000;

/** The only market-data keys any code path reads back from Redis after a
 *  restart (ATM-band seeding, OI warmup, trading-date guard, monitoring).
 *  Every other ltp:/oi: key is served from the in-process mirror. */
const PERSISTED_KEYS = new Set([
  "ltp:NIFTY-SPOT",
  "ltp:NIFTY-FUT",
  "oi:NIFTY-FUT",
]);

interface PendingWrite {
  value: string;
  ttlSeconds: number;
}

const dirty = new Map<string, PendingWrite>();
// Authoritative latest value per key for this process (all keys, persisted or not).
const mirror = new Map<string, string>();
// Last value/time actually sent to Redis per persisted key (change-detection + throttle).
const lastPersistedValue = new Map<string, string>();
const lastPersistedAt = new Map<string, number>();
// Negative read-through cache: keys confirmed absent in Redis (bounded retry).
const absentUntil = new Map<string, number>();
const ABSENT_CACHE_MS = 60_000;

let flushing = false;
let flushTimer: NodeJS.Timeout | null = null;

// Telemetry for the periodic stats line and the optimization report.
let commandsBuffered = 0;
let commandsSent = 0;
let flushCount = 0;
let readMirrorHits = 0;
let readRedisFallbacks = 0;
let lastErrorLogTs = 0;

const queueIfPersisted = (key: string, value: string, ttlSeconds: number) => {
  if (!PERSISTED_KEYS.has(key)) return;
  if (lastPersistedValue.get(key) === value) return; // unchanged — never rewrite
  const at = lastPersistedAt.get(key) ?? 0;
  if (Date.now() - at < PERSIST_MIN_INTERVAL_MS) return; // throttled
  dirty.set(key, { value, ttlSeconds });
};

export const bufferSet = (key: string, value: string) => {
  commandsBuffered++;
  mirror.set(key, value);
  absentUntil.delete(key);
  queueIfPersisted(key, value, MARKET_TTL_SECONDS);
};

export const bufferSetex = (key: string, ttlSeconds: number, value: string) => {
  commandsBuffered++;
  mirror.set(key, value);
  absentUntil.delete(key);
  queueIfPersisted(key, value, ttlSeconds);
};

/** Latest buffered value for a key (undefined if never written this session). */
export const getBufferedValue = (key: string): string | undefined => mirror.get(key);

/**
 * Memory-first read for live runtime keys (ltp:*, oi:*, config:*).
 * A mirror hit costs zero Redis commands — the common case whenever the feed
 * is running, since writer and readers share this process. Falls back to one
 * Redis GET per key (used for restart warmup), caches the result, and
 * negative-caches misses for 60s so absent keys can't generate request storms.
 */
export const readLive = async (key: string): Promise<string | null> => {
  const cached = mirror.get(key);
  if (cached !== undefined) {
    readMirrorHits++;
    return cached;
  }
  const absentTs = absentUntil.get(key);
  if (absentTs !== undefined && Date.now() < absentTs) {
    readMirrorHits++;
    return null;
  }
  readRedisFallbacks++;
  try {
    const value = await redis.get(key);
    if (value != null) {
      mirror.set(key, String(value));
      return String(value);
    }
  } catch (err: any) {
    if (Date.now() - lastErrorLogTs > 10_000) {
      console.warn(`[RedisBuffer] readLive('${key}') failed (${err?.message || err}), falling back to in-memory store`);
      lastErrorLogTs = Date.now();
    }
  }
  absentUntil.set(key, Date.now() + ABSENT_CACHE_MS);
  return null;
};

export const getWriteBufferStats = () => ({
  commandsBuffered,
  commandsSent,
  flushCount,
  dirtyKeys: dirty.size,
  mirrorKeys: mirror.size,
  readMirrorHits,
  readRedisFallbacks,
});

const flush = async () => {
  if (flushing || dirty.size === 0) return;
  flushing = true;

  // Snapshot + clear so ticks arriving during the flush are captured next cycle.
  const batch = new Map(dirty);
  dirty.clear();

  try {
    const pipelineFn = (redis as any).pipeline;
    if (typeof pipelineFn === "function") {
      // Upstash SDK and ioredis both support pipeline(): one HTTP request /
      // one socket round-trip for the whole batch (≤4 keys by design).
      const p = (redis as any).pipeline();
      for (const [key, w] of batch) p.setex(key, w.ttlSeconds, w.value);
      await p.exec();
    } else {
      // MockRedis fallback — sequential, but volume is already tiny.
      for (const [key, w] of batch) await redis.setex(key, w.ttlSeconds, w.value);
    }
    const now = Date.now();
    for (const [key, w] of batch) {
      lastPersistedValue.set(key, w.value);
      lastPersistedAt.set(key, now);
    }
    commandsSent += batch.size;
    flushCount++;
  } catch (err: any) {
    // Re-mark failed keys dirty (unless a newer value already superseded them)
    // so the next cycle retries. Bounded: persisted key space is ≤4 keys.
    for (const [key, w] of batch) {
      if (!dirty.has(key)) dirty.set(key, w);
    }
    const now = Date.now();
    if (now - lastErrorLogTs > 30_000) {
      lastErrorLogTs = now;
      console.warn(`[RedisBuffer] Flush failed (${batch.size} keys, will retry): ${err?.message || err}`);
    }
  } finally {
    flushing = false;
  }
};

export const startRedisWriteBuffer = () => {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  console.log(
    `[RedisBuffer] In-memory live store active — Redis persists only ${PERSISTED_KEYS.size} warmup key(s), ` +
    `max 1 write/key/${PERSIST_MIN_INTERVAL_MS / 1000}s, TTL ${MARKET_TTL_SECONDS}s (matches MongoDB daily lifecycle).`
  );
};

export const stopRedisWriteBuffer = () => {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
};

/**
 * One-time hygiene at startup: legacy ltp:/oi: keys were written with plain SET
 * (no TTL) and survive forever — exactly the overnight cache leakage this
 * redesign removes. Stamp a 25h TTL on any such key so the old key space
 * converges to the same daily lifecycle without manual cleanup. Guarded by a
 * marker key so the scan doesn't repeat on every deploy within a week.
 */
export const sweepLegacyMarketKeys = async () => {
  try {
    const marker = await redis.get("maint:ttl_sweep_done");
    if (marker) return;

    const scanFn = (redis as any).scan;
    if (typeof scanFn !== "function") return; // MockRedis — nothing to sweep

    let cursor: string | number = 0;
    let stamped = 0;
    let scanned = 0;
    do {
      // Both clients return [cursor, keys] but take different option shapes:
      // @upstash/redis wants an options object, ioredis wants variadic args.
      let next: string | number;
      let keys: string[];
      try {
        [next, keys] = await (redis as any).scan(cursor, { match: "*", count: 500 });
      } catch {
        [next, keys] = await (redis as any).scan(cursor, "MATCH", "*", "COUNT", 500);
      }
      cursor = next;
      for (const key of keys) {
        scanned++;
        if (!key.startsWith("ltp:") && !key.startsWith("oi:")) continue;
        const ttl = await redis.ttl(key);
        if (ttl === -1) {
          await redis.expire(key, MARKET_TTL_SECONDS);
          stamped++;
        }
      }
    } while (String(cursor) !== "0");

    await redis.setex("maint:ttl_sweep_done", 7 * 24 * 3600, new Date().toISOString());
    console.log(`[RedisBuffer] Legacy TTL sweep: scanned ${scanned} key(s), stamped 25h TTL on ${stamped} permanent market key(s).`);
  } catch (err: any) {
    console.warn(`[RedisBuffer] Legacy TTL sweep skipped: ${err?.message || err}`);
  }
};

// Start immediately on module load — the buffer is a pure infrastructure layer
// and must be running before the first tick arrives.
startRedisWriteBuffer();
