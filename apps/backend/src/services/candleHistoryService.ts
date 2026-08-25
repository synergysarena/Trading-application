import { marketDataEvents } from "./marketDataEvents";
import { MinuteCandle } from "./minuteAggregationService";
import { getRedisClient } from "./redisService";

/**
 * Candle Persistence (Phase 10, Steps 3-4).
 *
 * Subscribes ONLY to CANDLE_COMPLETED — never a partial/forming candle, never
 * a raw tick. Nothing else in the backend writes to these Redis keys.
 *
 * Key structure: one Redis LIST per instrument, newest candle at index 0
 * (LPUSH), capped to MOD2_CANDLE_HISTORY_LIMIT entries (LTRIM) with a
 * refreshed TTL (EXPIRE) on every write so a day's history self-cleans
 * without a separate sweep job — the same self-cleaning-via-TTL pattern
 * already used elsewhere in this project (see the 90000s/25h convention on
 * the existing live-tick mirror). A single list (rather than a separate
 * "latest" key + a history key) keeps this to 3 Redis commands per
 * persisted candle — deliberately minimal given the account's Redis command
 * quota is already under pressure (see Known Limitations).
 */

export interface PersistedCandle {
  exchangeSegment: number | null;
  instrumentId: string;
  tradingSymbol: string | null;
  minuteStart: string;
  minuteEnd: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  openInterest: number | null;
  tickCount: number;
  persistedAt: string;
}

export interface CandleHistoryStats {
  connected: boolean;
  totalSaved: number;
  totalSaveFailures: number;
  lastSavedAt: string | null;
  lastError: string | null;
  historyLimit: number;
  historyTtlSeconds: number;
}

const HISTORY_LIMIT = Number(process.env.MOD2_CANDLE_HISTORY_LIMIT) || 200;
const HISTORY_TTL_SECONDS = Number(process.env.MOD2_CANDLE_HISTORY_TTL_SECONDS) || 90_000; // 25h

const historyKey = (instrumentId: string): string => `mod2:candles:history:${instrumentId}`;

let totalSaved = 0;
let totalSaveFailures = 0;
let lastSavedAt: Date | null = null;
let lastError: string | null = null;

const toPersistedCandle = (candle: MinuteCandle): PersistedCandle => ({
  exchangeSegment: candle.exchangeSegment,
  instrumentId: candle.exchangeInstrumentID,
  tradingSymbol: candle.tradingSymbol,
  minuteStart: candle.minuteStartTime,
  minuteEnd: candle.minuteEndTime,
  open: candle.open,
  high: candle.high,
  low: candle.low,
  close: candle.close,
  volume: candle.volume,
  openInterest: candle.openInterest,
  tickCount: candle.tickCount,
  persistedAt: new Date().toISOString(),
});

/** Persists one COMPLETED candle. Never called with a forming/partial candle. */
export const saveCandle = async (candle: MinuteCandle): Promise<boolean> => {
  const client = getRedisClient();
  if (!client) {
    lastError = "Redis not connected — candle not persisted.";
    totalSaveFailures += 1;
    return false;
  }

  const key = historyKey(candle.exchangeInstrumentID);
  const payload = JSON.stringify(toPersistedCandle(candle));

  try {
    await client.lpush(key, payload);
    await client.ltrim(key, 0, HISTORY_LIMIT - 1);
    await client.expire(key, HISTORY_TTL_SECONDS);

    totalSaved += 1;
    lastSavedAt = new Date();
    lastError = null;
    return true;
  } catch (err: any) {
    lastError = err?.message || String(err);
    totalSaveFailures += 1;
    console.error(`[CandleHistory] Failed to persist candle for ${candle.exchangeInstrumentID}:`, lastError);
    return false;
  }
};

export const getLatestCandle = async (instrumentId: string): Promise<PersistedCandle | null> => {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const raw: string | null = await client.lindex(historyKey(instrumentId), 0);
    if (!raw) return null;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as PersistedCandle;
  } catch (err: any) {
    console.error(`[CandleHistory] getLatestCandle failed for ${instrumentId}:`, err?.message || err);
    return null;
  }
};

export const getRecentCandles = async (instrumentId: string, limit = 50): Promise<PersistedCandle[]> => {
  const client = getRedisClient();
  if (!client) return [];

  const cappedLimit = Math.max(1, Math.min(limit, HISTORY_LIMIT));
  try {
    const raw: any[] = await (client as any).lrange(historyKey(instrumentId), 0, cappedLimit - 1);
    return (raw || []).map((r: any) => (typeof r === "string" ? JSON.parse(r) : r) as PersistedCandle);
  } catch (err: any) {
    console.error(`[CandleHistory] getRecentCandles failed for ${instrumentId}:`, err?.message || err);
    return [];
  }
};

export const deleteInstrumentHistory = async (instrumentId: string): Promise<boolean> => {
  const client = getRedisClient();
  if (!client) return false;

  try {
    const removed = await client.del(historyKey(instrumentId));
    return removed > 0;
  } catch (err: any) {
    console.error(`[CandleHistory] deleteInstrumentHistory failed for ${instrumentId}:`, err?.message || err);
    return false;
  }
};

export const getHistoryStats = (): CandleHistoryStats => ({
  connected: !!getRedisClient(),
  totalSaved,
  totalSaveFailures,
  lastSavedAt: lastSavedAt ? lastSavedAt.toISOString() : null,
  lastError,
  historyLimit: HISTORY_LIMIT,
  historyTtlSeconds: HISTORY_TTL_SECONDS,
});

let initialized = false;

/** Called once at server startup. Subscribes ONLY to CANDLE_COMPLETED. */
export const initCandleHistory = (): void => {
  if (initialized) return;
  initialized = true;

  marketDataEvents.on("CANDLE_COMPLETED", (candle: MinuteCandle) => {
    saveCandle(candle).catch((err: any) => {
      console.error("[CandleHistory] Unexpected saveCandle error:", err?.message || err);
    });
  });

  console.log("[CandleHistory] Initialized — persisting CANDLE_COMPLETED events to Redis.");
};
