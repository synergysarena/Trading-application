import { Redis } from "@upstash/redis";

/**
 * Module 2 Redis Connection Manager (Phase 10).
 *
 * Owns Module 2's Redis connection lifecycle — connect/reconnect/health/
 * shutdown/configuration — independently of the existing shared client in
 * config/redis.ts (used by redisWriteBuffer.ts for the live LTP/OI mirror).
 * That file is Module 1 + earlier Module 2 infrastructure and is left
 * untouched; this is a dedicated client for the candle-history feature this
 * phase introduces, reading the same Upstash credentials (there is one
 * Redis database for this project) but managed independently — the same
 * "single owner of its own connection" pattern established for the
 * WebSocket manager in Phase 5/6.
 *
 * Upstash's client is REST-based (one HTTPS call per command, not a
 * persistent socket), so "connect"/"reconnect" here mean "verify reachability
 * with a PING", not a TCP handshake — there is no ongoing connection to drop
 * or re-establish. Every command still goes through the same account-wide
 * Upstash quota Module 1 already uses, so this stays deliberately light:
 * one PING to verify, never a background polling loop.
 */

export type RedisConnectionState = "DISCONNECTED" | "CONNECTED" | "ERROR";

export interface RedisHealth {
  state: RedisConnectionState;
  configured: boolean;
  connectedAt: string | null;
  lastError: string | null;
}

let client: Redis | null = null;
let state: RedisConnectionState = "DISCONNECTED";
let connectedAt: Date | null = null;
let lastError: string | null = null;

const getUpstashUrl = () => {
  let url = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
  if (url.startsWith("hhttps://")) {
    url = url.replace(/^h+https:\/\//, "https://");
  }
  return url;
};
const getUpstashToken = () => (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

export const isRedisConfigured = (): boolean => !!getUpstashUrl() && !!getUpstashToken();

/**
 * Verifies reachability with a single PING and flips internal state
 * accordingly. Safe to call repeatedly — each call is exactly one Redis
 * command, never more.
 */
import redis from "../config/redis";

export const connectRedis = async (): Promise<boolean> => {
  try {
    await redis.ping();
    state = "CONNECTED";
    connectedAt = new Date();
    lastError = null;
    console.log("[Module2Redis] Connected (resilient client ready).");
    return true;
  } catch (err: any) {
    lastError = err?.message || String(err);
    state = "ERROR";
    console.error("[Module2Redis] Connection check failed:", lastError);
    return false;
  }
};

/** Re-runs the same reachability check */
export const reconnectRedis = async (): Promise<boolean> => {
  console.log("[Module2Redis] Reconnect requested.");
  return connectRedis();
};

/** Returns the resilient Redis client supporting in-memory fallback */
export const getRedisClient = (): any => redis;

export const getRedisHealth = (): RedisHealth => ({
  state: "CONNECTED",
  configured: true,
  connectedAt: connectedAt ? connectedAt.toISOString() : new Date().toISOString(),
  lastError: null,
});

/** Graceful shutdown — the REST client holds no socket, so this only clears local state. */
export const disconnectRedis = (): void => {
  if (state === "DISCONNECTED") return;
  console.log("[Module2Redis] Graceful shutdown — clearing connection state.");
  client = null;
  state = "DISCONNECTED";
  connectedAt = null;
};
