import { FuturesOHLC } from "../models/FuturesOHLC";
import { Tick, Candle } from "@stock/shared";
import { readLive } from "./redisWriteBuffer";
import { archiveModule1Candles } from "./module1ArchiveService";
import { isMarketDataProcessingEnabled } from "./marketDataLifecycle";

// Symbols that require continuous minute timeline (synthetic carry-forward when no tick arrives)
// Option contracts are strictly tick-based and NOT synthesized automatically.
const CONTINUOUS_SYMBOLS = new Set(["NIFTY-SPOT", "NIFTY-FUT"]);

// Standard timeframes tracked for proactive continuity
const CONTINUITY_TIMEFRAMES = ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "45m", "1h", "2h", "3h", "4h"];

// Local cache for active in-progress candles: activeCandles[symbol][timeframe]
const activeCandles: Record<string, Record<string, Candle>> = {};

// Local cache for finalized candles: finalizedCandlesCache[symbol][timeframe]
const finalizedCandlesCache: Record<string, Record<string, Candle[]>> = {};

// Last known close price per symbol and timeframe (used for carry-forward open/close)
const lastKnownClose: Record<string, Record<string, number>> = {};

let boundaryInterval: NodeJS.Timeout | null = null;

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
export const startBoundaryChecker = () => {
  if (boundaryInterval) return;
  boundaryInterval = setInterval(async () => {
    if (!isMarketDataProcessingEnabled()) return;
    const now = Date.now();
    const sessionOpenMs = getTodaySessionOpenMs();

    // 1. Proactive finalization for active candles that have crossed their boundary
    for (const symbol of Object.keys(activeCandles)) {
      for (const tfStr of Object.keys(activeCandles[symbol])) {
        if (!isMarketDataProcessingEnabled()) return;
        const candle = activeCandles[symbol][tfStr];
        if (!candle) continue;

        const tfMins = await getTimeframeMinutes(tfStr);
        if (!isMarketDataProcessingEnabled()) return;

        // Re-check identity after the await: a tick may have finalized and
        // replaced this candle while getTimeframeMinutes yielded.
        if (activeCandles[symbol]?.[tfStr] !== candle) continue;

        const nextBoundary = candle.openTime + tfMins * 60000;

        if (now >= nextBoundary) {
          if (!isMarketDataProcessingEnabled()) return;
          console.log(`[MODULE1][BOUNDARY] Proactive finalization for ${symbol} (${tfStr}) at ${new Date(candle.openTime).toISOString()}.`);
          const candleToFinalize = candle;
          delete activeCandles[symbol][tfStr];
          if (!lastKnownClose[symbol]) lastKnownClose[symbol] = {};
          lastKnownClose[symbol][tfStr] = candleToFinalize.close;
          await finaliseCandle(candleToFinalize);
        }
      }
    }

    // 2. Continuity check for NIFTY-SPOT and NIFTY-FUT:
    // If a minute has elapsed with NO ticks received, create a synthetic carry-forward candle.
    for (const symbol of CONTINUOUS_SYMBOLS) {
      if (!isMarketDataProcessingEnabled()) return;
      for (const tfStr of CONTINUITY_TIMEFRAMES) {
        const prevClose = lastKnownClose[symbol]?.[tfStr];
        if (prevClose === undefined || prevClose <= 0) continue;

        const tfMins = await getTimeframeMinutes(tfStr);
        if (!isMarketDataProcessingEnabled()) return;

        const currentBoundary = getBoundaryTime(new Date(now), tfMins);
        const prevBoundary = currentBoundary - tfMins * 60000;

        // Only create carry-forward bars within the current trading session
        if (prevBoundary < sessionOpenMs) continue;

        // Check if an active candle exists for prevBoundary or currentBoundary
        const active = activeCandles[symbol]?.[tfStr];
        if (active && active.openTime >= prevBoundary) continue;

        // Check if a finalized candle already exists for prevBoundary
        const cachedList = finalizedCandlesCache[symbol]?.[tfStr] || [];
        const hasFinalized = cachedList.some(c => c.openTime === prevBoundary);
        if (hasFinalized) continue;

        // No active candle and no finalized candle for prevBoundary -> generate synthetic carry-forward candle
        const syntheticCandle: Candle = {
          symbol,
          timeframe: tfStr,
          open: prevClose,
          high: prevClose,
          low: prevClose,
          close: prevClose,
          openTime: prevBoundary,
          volume: 0,
          isSynthetic: true,
        };

        console.log(`[MODULE1][BOUNDARY] Generated synthetic carry-forward candle for ${symbol} (${tfStr}) at ${new Date(prevBoundary).toISOString()} (close=${prevClose}).`);
        await finaliseCandle(syntheticCandle);
      }
    }
  }, 1000);
};

export const stopBoundaryChecker = () => {
  if (boundaryInterval) {
    clearInterval(boundaryInterval);
    boundaryInterval = null;
  }
};

startBoundaryChecker();

export const clearActiveCandles = (): void => {
  stopBoundaryChecker();
  persistQueue.length = 0;
  for (const symbol of Object.keys(activeCandles)) {
    delete activeCandles[symbol];
  }
};

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
 * Aggregates a raw tick into the corresponding timeframe candles for that symbol.
 * Enforces strict timestamp-boundary matching.
 */
export const aggregateOHLC = async (tick: Tick, timeframeMinutes: number, timeframeStr: string): Promise<Candle> => {
  if (!isMarketDataProcessingEnabled()) {
    return {
      symbol: tick.symbol,
      timeframe: timeframeStr,
      open: tick.ltp,
      high: tick.ltp,
      low: tick.ltp,
      close: tick.ltp,
      openTime: getBoundaryTime(tick.timestamp, timeframeMinutes),
      volume: tick.volume || 0,
      isSynthetic: false,
    };
  }
  const { symbol, ltp, timestamp, volume = 0 } = tick;
  
  if (!activeCandles[symbol]) {
    activeCandles[symbol] = {};
  }
  if (!lastKnownClose[symbol]) {
    lastKnownClose[symbol] = {};
  }
  lastKnownClose[symbol][timeframeStr] = ltp;

  const boundary = getBoundaryTime(timestamp, timeframeMinutes);
  let candle = activeCandles[symbol][timeframeStr];

  // Check if a synthetic candle was previously finalized for this boundary
  const cachedList = finalizedCandlesCache[symbol]?.[timeframeStr] || [];
  const syntheticIdx = cachedList.findIndex(c => c.openTime === boundary && c.isSynthetic);

  if (!candle || candle.openTime < boundary) {
    // If there is an existing active candle, finalize it first
    if (candle) {
      await finaliseCandle(candle);
    }

    if (syntheticIdx >= 0) {
      // A synthetic candle was previously finalized for this exact boundary — overwrite it with real tick data
      const syn = cachedList[syntheticIdx];
      syn.open = ltp;
      syn.high = ltp;
      syn.low = ltp;
      syn.close = ltp;
      syn.volume = volume;
      syn.isSynthetic = false;
      console.log(`[MODULE1][AGGREGATOR] Real tick arrived for synthetic candle ${symbol} (${timeframeStr}) at ${new Date(boundary).toISOString()} — replaced synthetic bar.`);
      persistQueue.push({ ...syn });
      void drainPersistQueue();
      candle = syn;
    } else {
      // Initialize brand new real candle
      candle = {
        symbol,
        timeframe: timeframeStr,
        open: ltp,
        high: ltp,
        low: ltp,
        close: ltp,
        openTime: boundary,
        volume,
        isSynthetic: false,
      };
    }
  } else if (candle.openTime === boundary) {
    // Update existing active candle in the current boundary interval
    candle.high = Math.max(candle.high, ltp);
    candle.low = Math.min(candle.low, ltp);
    candle.close = ltp;
    candle.volume += volume;
    candle.isSynthetic = false;
    if (syntheticIdx >= 0) {
      cachedList[syntheticIdx] = { ...candle };
    }
  } else {
    // Out-of-order or late tick (boundary < candle.openTime):
    // Check if a synthetic candle was finalized for this exact boundary.
    // If so, replace/update that synthetic candle with real tick data without corrupting active candle.
    if (syntheticIdx >= 0) {
      const syn = cachedList[syntheticIdx];
      syn.open = ltp;
      syn.high = ltp;
      syn.low = ltp;
      syn.close = ltp;
      syn.volume = volume;
      syn.isSynthetic = false;
      console.log(`[MODULE1][AGGREGATOR] Late real tick arrived for synthetic candle ${symbol} (${timeframeStr}) at ${new Date(boundary).toISOString()} — replaced synthetic bar.`);
      persistQueue.push({ ...syn });
      void drainPersistQueue();
      return syn;
    }

    // Otherwise, this is a late tick for an already finalized real candle — do not corrupt current candle
    console.warn(`[MODULE1][AGGREGATOR] Late/out-of-order tick for ${symbol} (${timeframeStr}): tickTime=${timestamp.toISOString()} boundary=${new Date(boundary).toISOString()} currentCandle=${new Date(candle.openTime).toISOString()}`);
    return candle;
  }

  activeCandles[symbol][timeframeStr] = candle;

  // Diagnostic logger for 1m interval verification
  if (timeframeStr === "1m" && (symbol === "NIFTY-FUT" || symbol === "NIFTY-SPOT") && diagOhlc1mCount < MAX_DIAG_OHLC) {
    diagOhlc1mCount++;
    console.log(
      `[MODULE1][TICK][1m #${diagOhlc1mCount}] symbol=${symbol} min=${new Date(boundary).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })} ` +
      `tick=${ltp} -> O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} vol=${candle.volume}`
    );
  }

  return candle;
};

// ── Phase 6: persistence moved off the tick hot path ─────────────────────────
const persistQueue: Candle[] = [];
let draining = false;
const prunedSessions = new Map<string, number>();
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

let _persistErrCount = 0;
let _persistErrLastLog = 0;

// Single source of truth for the candle upsert op — includes is_synthetic
const candleToUpsertOp = (c: Candle) => ({
  updateOne: {
    filter: { symbol: c.symbol, timeframe: c.timeframe, bar_time: new Date(c.openTime) },
    update: {
      $set: {
        bar_open: c.open,
        bar_high: c.high,
        bar_low: c.low,
        bar_close: c.close,
        volume: c.volume,
        is_synthetic: !!c.isSynthetic,
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
  if (draining || !isMarketDataProcessingEnabled()) return;
  draining = true;
  try {
    while (persistQueue.length > 0) {
      if (!isMarketDataProcessingEnabled()) {
        persistQueue.length = 0;
        break;
      }
      const batch = persistQueue.splice(0, persistQueue.length);

      // Async fire-and-forget archival to Module1CandleArchive (real candles only)
      const realBatch = batch.filter(c => !c.isSynthetic);
      if (realBatch.length > 0) {
        void archiveModule1Candles(realBatch).catch(() => {});
      }

      // 1. One bulk upsert for the whole batch
      try {
        if (!isMarketDataProcessingEnabled()) break;
        await FuturesOHLC.bulkWrite(batch.map(candleToUpsertOp), { ordered: false });
        console.log(`[MODULE1][PERSIST] Persisted ${batch.length} finalized candle(s) in one bulk write.`);
      } catch (error: any) {
        if (!isMarketDataProcessingEnabled()) break;
        // E11000 duplicate key: retry duplicate-key ops
        const writeErrors: any[] = error?.writeErrors ?? [];
        const dupes = writeErrors.filter((we: any) => we?.code === 11000);
        let recovered = false;
        if (dupes.length > 0 && dupes.length === writeErrors.length) {
          try {
            await FuturesOHLC.bulkWrite(
              dupes.map((we: any) => candleToUpsertOp(batch[we.index])),
              { ordered: false }
            );
            console.log(`[MODULE1][PERSIST] Re-applied ${dupes.length} candle upsert(s) after duplicate-key race.`);
            recovered = true;
          } catch { /* fall through to failure logging */ }
        }
        if (!recovered) {
          _persistErrCount++;
          const now = Date.now();
          if (now - _persistErrLastLog > 10_000) {
            _persistErrLastLog = now;
            console.error(`[MODULE1][PERSIST][ERROR] Bulk persist failed (${_persistErrCount} failure(s) so far): ${error?.message || error}`);
          }
        }
      }

      // 2. Retention pruning — once per (symbol,timeframe) per session day
      for (const c of batch) {
        if (!isMarketDataProcessingEnabled()) break;
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
        } catch { /* retried next session */ }
      }

      // 3. Pivot recalculation per finalized candle (real candles only)
      if (onCandleFinalized && isMarketDataProcessingEnabled()) {
        for (const c of batch) {
          if (!isMarketDataProcessingEnabled()) break;
          // Only recalculate pivots on real traded bars
          if (c.isSynthetic) continue;
          try {
            await onCandleFinalized(c);
          } catch (err: any) {
            _persistErrCount++;
            const now = Date.now();
            if (now - _persistErrLastLog > 10_000) {
              _persistErrLastLog = now;
              console.error(`[MODULE1][PERSIST][ERROR] onCandleFinalized failed (${_persistErrCount} failure(s)): ${err?.message || err}`);
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
  if (!isMarketDataProcessingEnabled()) return;
  const candle: Candle = { ...liveCandle };
  const { symbol, timeframe } = candle;
  if (!finalizedCandlesCache[symbol]) finalizedCandlesCache[symbol] = {};
  if (!finalizedCandlesCache[symbol][timeframe]) finalizedCandlesCache[symbol][timeframe] = [];

  const existingIdx = finalizedCandlesCache[symbol][timeframe].findIndex(c => c.openTime === candle.openTime);
  if (existingIdx >= 0) {
    // If updating an existing synthetic candle with real candle or newer values, update it
    finalizedCandlesCache[symbol][timeframe][existingIdx] = candle;
  } else {
    finalizedCandlesCache[symbol][timeframe].push(candle);
    // Keep at most 400 candles in memory (enough for a full 1m intraday session: 375 candles)
    if (finalizedCandlesCache[symbol][timeframe].length > 400) {
      finalizedCandlesCache[symbol][timeframe].shift();
    }
  }

  persistQueue.push(candle);
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
