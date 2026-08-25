import { FuturesOHLC } from "../models/FuturesOHLC";
import { Tick, Candle } from "@stock/shared";
import { readLive } from "./redisWriteBuffer";
import { archiveModule1Candles } from "./module1ArchiveService";

// Local cache for active candles: activeCandles[symbol][timeframe]
const activeCandles: Record<string, Record<string, Candle>> = {};

const parseTfMinutes = (tf: string): number => {
  if (tf.endsWith("h")) {
    const h = parseInt(tf, 10);
    return !isNaN(h) && h > 0 ? h * 60 : 0;
  }
  if (tf.endsWith("m")) {
    const m = parseInt(tf, 10);
    return !isNaN(m) && m > 0 ? m : 0;
  }
  return 0;
};

const getTimeframeMinutes = async (tfStr: string): Promise<number> => {
  if (tfStr === "custom") {
    try {
      // Memory-first: mirror hit after the first read/set; at most one Redis
      // GET per process (restart warmup), instead of one per boundary check.
      const customTf = await readLive("config:custom_timeframe");
      if (customTf) {
        const mins = parseTfMinutes(customTf);
        if (mins > 0) return mins;
      }
    } catch {
      // Ignore Redis offline/read errors
    }
    return 10;
  }
  const mins = parseTfMinutes(tfStr);
  return mins > 0 ? mins : 5;
};

// Start a proactive checker loop on startup/module load
const startBoundaryChecker = () => {
  setInterval(async () => {
    const now = Date.now();
    for (const symbol of Object.keys(activeCandles)) {
      for (const tfStr of Object.keys(activeCandles[symbol])) {
        const candle = activeCandles[symbol][tfStr];
        if (!candle) continue;

        const tfMins = await getTimeframeMinutes(tfStr);

        // Re-check identity after the await: a tick may have finalized and
        // replaced this candle while getTimeframeMinutes yielded. Without this
        // check the same candle gets finalized twice and the freshly opened
        // replacement candle is deleted (boundary double-finalize race).
        if (activeCandles[symbol]?.[tfStr] !== candle) continue;

        const nextBoundary = candle.openTime + tfMins * 60000;

        if (now >= nextBoundary) {
          console.log(`[OHLC] Proactive finalization for ${symbol} (${tfStr}) on boundary.`);
          const candleToFinalize = candle;
          delete activeCandles[symbol][tfStr];
          await finaliseCandle(candleToFinalize);
        }
      }
    }
  }, 1000);
};

startBoundaryChecker();

// Callback to trigger pivot calculations when a candle is finalized
type CandleFinalizedCallback = (candle: Candle) => Promise<void> | void;
let onCandleFinalized: CandleFinalizedCallback | null = null;

export const setOnCandleFinalized = (callback: CandleFinalizedCallback) => {
  onCandleFinalized = callback;
};

// NSE session open: 09:15 IST = 03:45 UTC = 225 minutes from UTC midnight
const SESSION_OPEN_UTC_MINUTES = 3 * 60 + 45;

// Returns the millisecond timestamp of the current trading day's session open (03:45 UTC).
// If the current UTC time is before 03:45 today, returns yesterday's session open.
export const getTodaySessionOpenMs = (): number => {
  const now = Date.now();
  const todayMidnightMs = now - (now % (24 * 60 * 60000));
  const todaySessionOpenMs = todayMidnightMs + SESSION_OPEN_UTC_MINUTES * 60000;
  return now < todaySessionOpenMs ? todaySessionOpenMs - 24 * 60 * 60000 : todaySessionOpenMs;
};

/**
 * Normalizes time boundary based on timeframe in minutes.
 * For timeframes < 60 minutes, boundaries align to UTC midnight (which coincidentally
 * aligns with IST 09:15 for 1m/5m/15m/30m/45m because 225min is divisible by each).
 * For timeframes >= 60 minutes, boundaries are offset to the NSE session open (09:15 IST)
 * so that the first bar of the day starts exactly at market open, not at a UTC-midnight-
 * aligned time that precedes the session by 30–75 minutes.
 */
export const getBoundaryTime = (timestamp: Date, timeframeMinutes: number): number => {
  const timeMs = timestamp.getTime();
  const timeframeMs = timeframeMinutes * 60000;

  if (timeframeMinutes < 60) {
    return Math.floor(timeMs / timeframeMs) * timeframeMs;
  }

  // Anchor to session open so the first bar of the day starts at 09:15 IST (03:45 UTC)
  const sessionOpenMs = SESSION_OPEN_UTC_MINUTES * 60000; // ms from UTC midnight
  // Find midnight UTC for the same day as the timestamp
  const midnightMs = timeMs - (timeMs % (24 * 60 * 60000));
  const todaySessionOpenMs = midnightMs + sessionOpenMs;
  const offsetMs = timeMs - todaySessionOpenMs;
  if (offsetMs < 0) {
    // Tick is before today's session open — snap to previous session's last boundary
    const prevSessionOpenMs = todaySessionOpenMs - 24 * 60 * 60000;
    return prevSessionOpenMs + Math.floor((timeMs - prevSessionOpenMs) / timeframeMs) * timeframeMs;
  }
  return todaySessionOpenMs + Math.floor(offsetMs / timeframeMs) * timeframeMs;
};

// Controlled diagnostic logging for Module 1 OHLC candle aggregation
let diagOhlc1mCount = 0;
const MAX_DIAG_OHLC = 20;

/**
 * Aggregates a raw tick into the corresponding timeframe candles for that symbol
 */
export const aggregateOHLC = async (tick: Tick, timeframeMinutes: number, timeframeStr: string): Promise<Candle> => {
  const { symbol, ltp, timestamp, volume = 0 } = tick;
  
  if (!activeCandles[symbol]) {
    activeCandles[symbol] = {};
  }

  const boundary = getBoundaryTime(timestamp, timeframeMinutes);
  let candle = activeCandles[symbol][timeframeStr];

  if (!candle || candle.openTime < boundary) {
    // If there is an existing active candle, it has crossed the timeframe boundary, so finalize it.
    if (candle) {
      await finaliseCandle(candle);
    }

    // Initialize brand new candle
    candle = {
      symbol,
      timeframe: timeframeStr,
      open: ltp,
      high: ltp,
      low: ltp,
      close: ltp,
      openTime: boundary,
      volume,
    };
  } else if (candle.openTime === boundary) {
    // Update existing active candle in the current boundary interval
    candle.high = Math.max(candle.high, ltp);
    candle.low = Math.min(candle.low, ltp);
    candle.close = ltp;
    candle.volume += volume;
  } else {
    // Out-of-order or late tick (boundary < candle.openTime):
    // Do NOT corrupt the current in-progress candle with historical tick data.
    console.warn(`[OHLC] Late/out-of-order tick for ${symbol} (${timeframeStr}): tickTime=${timestamp.toISOString()} boundary=${new Date(boundary).toISOString()} currentCandle=${new Date(candle.openTime).toISOString()}`);
    return candle;
  }

  activeCandles[symbol][timeframeStr] = candle;

  // Diagnostic logger for 1m interval verification
  if (timeframeStr === "1m" && (symbol === "NIFTY-FUT" || symbol === "NIFTY-SPOT") && diagOhlc1mCount < MAX_DIAG_OHLC) {
    diagOhlc1mCount++;
    console.log(
      `[OHLC DEBUG][1m #${diagOhlc1mCount}] symbol=${symbol} min=${new Date(boundary).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })} ` +
      `tick=${ltp} -> O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} vol=${candle.volume}`
    );
  }

  return candle;
};

const finalizedCandlesCache: Record<string, Record<string, Candle[]>> = {};

// ── Phase 6: persistence moved off the tick hot path ─────────────────────────
//
// finaliseCandle used to await a Mongo upsert + deleteMany per candle, inside
// the tick-processing chain. At each 1m boundary that meant a burst of hundreds
// of concurrent Mongo ops (84 symbols × upsert + prune + 3 pivot inserts) racing
// with the Upstash flood — see PHASE5_VALIDATION_REPORT.md §9. Candles are now
// queued and drained by a single serialized worker: one bulkWrite per drain,
// session pruning at most once per (symbol,timeframe) per session, and the
// pivot callback still fires once per finalized candle (serially, so Mongo
// concurrency stays bounded). Bar values and finalize triggers are unchanged.

const persistQueue: Candle[] = [];
let draining = false;
// Tracks the session-open ms already pruned per "symbol|timeframe" so the
// deleteMany cleanup runs once per pair per session instead of per candle.
const prunedSessions = new Map<string, number>();
// Rolling retention window for the prune below — matches the 24-hour TTL index in
// FuturesOHLCSchema.ts (86,400 seconds). Kept as an explicit deleteMany (rather than
// relying on the TTL alone) so the collection stays bounded even if the TTL
// background task lags.
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

let _persistErrCount = 0;
let _persistErrLastLog = 0;

// Single source of truth for the candle upsert op — the initial bulk write and
// the duplicate-key retry must persist the exact same doc for the same filter.
const candleToUpsertOp = (c: Candle) => ({
  updateOne: {
    filter: { symbol: c.symbol, timeframe: c.timeframe, bar_time: new Date(c.openTime) },
    update: {
      $set: {
        bar_open: c.open, bar_high: c.high, bar_low: c.low,
        bar_close: c.close, volume: c.volume,
      },
    },
    upsert: true,
  },
});

const sessionOpenForCandle = (openTimeMs: number): number => {
  const sessionOpen = new Date(openTimeMs);
  sessionOpen.setUTCHours(3, 45, 0, 0); // 09:15 IST
  if (sessionOpen.getTime() > openTimeMs) {
    sessionOpen.setUTCDate(sessionOpen.getUTCDate() - 1);
  }
  return sessionOpen.getTime();
};

const drainPersistQueue = async () => {
  if (draining) return;
  draining = true;
  try {
    while (persistQueue.length > 0) {
      const batch = persistQueue.splice(0, persistQueue.length);

      // Async fire-and-forget archival to Module1CandleArchive
      void archiveModule1Candles(batch).catch(() => {});

      // 1. One bulk upsert for the whole batch (same doc shape/filter as the
      //    previous per-candle findOneAndUpdate upsert).
      try {
        await FuturesOHLC.bulkWrite(batch.map(candleToUpsertOp), { ordered: false });
        console.log(`[OHLC] Persisted ${batch.length} finalized candle(s) in one bulk write.`);
      } catch (error: any) {
        // E11000 duplicate key: two upserts raced on the same (symbol,
        // timeframe, bar_time) key and the unique index rejected the loser.
        // The doc now exists, so re-running the identical op is a plain
        // update — retry only the duplicate-key ops (unordered bulkWrite
        // already applied every non-failing op).
        const writeErrors: any[] = error?.writeErrors ?? [];
        const dupes = writeErrors.filter((we: any) => we?.code === 11000);
        let recovered = false;
        if (dupes.length > 0 && dupes.length === writeErrors.length) {
          try {
            await FuturesOHLC.bulkWrite(
              dupes.map((we: any) => candleToUpsertOp(batch[we.index])),
              { ordered: false }
            );
            console.log(`[OHLC] Re-applied ${dupes.length} candle upsert(s) after duplicate-key race.`);
            recovered = true;
          } catch { /* fall through to the failure counter below */ }
        }
        if (!recovered) {
          _persistErrCount++;
          const now = Date.now();
          if (now - _persistErrLastLog > 30_000) {
            _persistErrLastLog = now;
            console.error(`[OHLC] Bulk persist failed (${_persistErrCount} failure(s) so far, in-memory cache unaffected): ${error?.message || error}`);
          }
        }
      }

      // 2. Retention pruning — once per (symbol,timeframe) per session day.
      // Cutoff is a rolling 45-day window (matches the TTL index), not
      // "today's session open" — see HISTORY_RETENTION_MS above.
      for (const c of batch) {
        const key = `${c.symbol}|${c.timeframe}`;
        const sessionOpenMs = sessionOpenForCandle(c.openTime);
        if (prunedSessions.get(key) === sessionOpenMs) continue;
        prunedSessions.set(key, sessionOpenMs);
        try {
          await FuturesOHLC.deleteMany({
            symbol: c.symbol,
            timeframe: c.timeframe,
            bar_time: { $lt: new Date(Date.now() - HISTORY_RETENTION_MS) },
          });
        } catch { /* retried next session; cache-side filtering already excludes old bars */ }
      }

      // 3. Pivot recalculation per finalized candle — unchanged semantics,
      //    now serialized so Mongo insert concurrency stays bounded.
      if (onCandleFinalized) {
        for (const c of batch) {
          try {
            await onCandleFinalized(c);
          } catch (err: any) {
            _persistErrCount++;
            const now = Date.now();
            if (now - _persistErrLastLog > 30_000) {
              _persistErrLastLog = now;
              console.error(`[OHLC] onCandleFinalized failed (${_persistErrCount} failure(s) so far): ${err?.message || err}`);
            }
          }
        }
      }
    }
  } finally {
    draining = false;
  }
};

/**
 * Records a finalized candle in the in-memory cache (synchronously — readers see
 * it immediately) and queues it for background persistence + pivot recalc.
 */
const finaliseCandle = async (liveCandle: Candle) => {
  // Snapshot: the live object could still be mutated by a racing tick between
  // queueing and the background bulk write — cache and persist frozen values.
  const candle: Candle = { ...liveCandle };
  const { symbol, timeframe } = candle;
  if (!finalizedCandlesCache[symbol]) finalizedCandlesCache[symbol] = {};
  if (!finalizedCandlesCache[symbol][timeframe]) finalizedCandlesCache[symbol][timeframe] = [];

  const existingIdx = finalizedCandlesCache[symbol][timeframe].findIndex(c => c.openTime === candle.openTime);
  if (existingIdx >= 0) {
    finalizedCandlesCache[symbol][timeframe][existingIdx] = candle;
  } else {
    finalizedCandlesCache[symbol][timeframe].push(candle);
    // Keep at most 400 candles in memory (enough for a full 1m intraday session: 375 candles)
    if (finalizedCandlesCache[symbol][timeframe].length > 400) {
      finalizedCandlesCache[symbol][timeframe].shift();
    }
  }

  persistQueue.push(candle);
  // Fire-and-forget: the worker single-flights, so concurrent calls coalesce.
  void drainPersistQueue();
};

/**
 * Returns latest cached completed candles for the current trading session only.
 * Bars from previous sessions are excluded so stale data is never served.
 */
export const getCachedOHLCBars = (symbol: string, timeframe: string, limit = 400): Candle[] => {
  const sessionOpenMs = getTodaySessionOpenMs();
  const list = (finalizedCandlesCache[symbol]?.[timeframe] || [])
    .filter(c => c.openTime >= sessionOpenMs);
  return list.slice(-limit);
};

/**
 * Gets the current active candle for a symbol and timeframe
 */
export const getActiveCandle = (symbol: string, timeframeStr: string): Candle | null => {
  return activeCandles[symbol]?.[timeframeStr] || null;
};
