import { FuturesOHLC } from "../models/FuturesOHLC";
import { Tick, Candle } from "@stock/shared";
import { readLive } from "./redisWriteBuffer";
import { archiveModule1Candles } from "./module1ArchiveService";
import { isMarketDataProcessingEnabled } from "./marketDataLifecycle";
import { isOhlcAuditEnabled, auditLog, getPipelineMinute } from "./module1OhlcAudit";
import { mongoConnectionStateName } from "../config/db";
import { debugLog } from "../utils/logger";

/**
 * Grace period applied to TIMER-based (proactive) candle finalization only.
 *
 * The boundary checker fires every 1s; without a grace period it finalizes a
 * candle the instant wall-clock passes its boundary. Broker feed timestamps
 * (Zebu `ft`) lag wall-clock by 1-3s, so genuinely in-minute ticks kept
 * arriving AFTER finalization — and because the active candle was already
 * deleted, each such late tick used to recreate a fresh 1-tick candle for the
 * (past) minute, which then OVERWROTE the correct multi-tick candle in the
 * cache and in MongoDB with a flat open=high=low=close bar.
 *
 * A tick that itself crosses the boundary still finalizes the old candle
 * immediately (that path is unaffected) — the grace only delays the fallback
 * TIMER finalization for a quiet symbol.
 */
const PROACTIVE_FINALIZE_GRACE_MS = Number(process.env.MODULE1_LATE_TICK_GRACE_MS) || 3000;

// ── Per-candle tick audit (diagnostic only) ─────────────────────────────────
interface CandleAudit { ticks: number; prices: Set<number>; first: number; last: number }
const candleAudit = new WeakMap<Candle, CandleAudit>();

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

        // Grace period: let feed-timestamp-lagged in-minute ticks land in this
        // candle before the timer finalizes it. A tick that crosses the
        // boundary still finalizes it immediately (see aggregateOHLC).
        if (now >= nextBoundary + PROACTIVE_FINALIZE_GRACE_MS) {
          if (!isMarketDataProcessingEnabled()) return;
          debugLog(`[MODULE1][BOUNDARY] Proactive finalization for ${symbol} (${tfStr}) at ${new Date(candle.openTime).toISOString()}.`);
          const candleToFinalize = candle;
          delete activeCandles[symbol][tfStr];
          if (!lastKnownClose[symbol]) lastKnownClose[symbol] = {};
          lastKnownClose[symbol][tfStr] = candleToFinalize.close;
          await finaliseCandle(candleToFinalize);
        }
      }
    }

    // 2. Continuity check for NIFTY-SPOT and NIFTY-FUT: fill every elapsed
    //    minute that received no ticks with a synthetic carry-forward candle.
    await fillContinuityCandles(now, sessionOpenMs);
  }, 1000);
};

/**
 * Guarantees a GAP-FREE FUT/SPOT candle timeline: for each continuous symbol /
 * timeframe, fills every boundary between the most recent existing candle and
 * `prevBoundary` (one before the current forming minute) that has no candle
 * with a flat carry-forward synthetic bar.
 *
 * Previously this only ever considered the single boundary immediately before
 * now, and it bailed whenever ANY active candle existed — so a zero-tick minute
 * whose successor got its first tick before the 1s checker ran was skipped
 * forever, leaving a permanent hole that surfaced as a missing worksheet row.
 *
 * Exported for deterministic testing (see test_module1_timeline_continuity.ts).
 */
export const fillContinuityCandles = async (now: number, sessionOpenMs: number): Promise<void> => {
  for (const symbol of CONTINUOUS_SYMBOLS) {
    if (!isMarketDataProcessingEnabled()) return;
    for (const tfStr of CONTINUITY_TIMEFRAMES) {
      const prevClose = lastKnownClose[symbol]?.[tfStr];
      if (prevClose === undefined || prevClose <= 0) continue;

      const tfMins = await getTimeframeMinutes(tfStr);
      if (!isMarketDataProcessingEnabled()) return;

      const tfMs = tfMins * 60000;
      const currentBoundary = getBoundaryTime(new Date(now), tfMins);
      const prevBoundary = currentBoundary - tfMs;

      // Only create carry-forward bars within the current trading session
      if (prevBoundary < sessionOpenMs) continue;

      const cachedList = finalizedCandlesCache[symbol]?.[tfStr] || [];
      const active = activeCandles[symbol]?.[tfStr];

      // Most recent boundary that already has a candle (finalized OR active).
      let lastCovered = -1;
      for (const c of cachedList) if (c.openTime > lastCovered) lastCovered = c.openTime;
      if (active && active.openTime > lastCovered) lastCovered = active.openTime;
      if (lastCovered < 0) continue; // no real tick yet — nothing to carry forward

      // Fill EVERY empty boundary from there through prevBoundary. Bounded per
      // pass so a long stall recovers over a few ticks, not one large burst.
      const finalizedSet = new Set(cachedList.map(c => c.openTime));
      let filled = 0;
      for (let b = Math.max(lastCovered + tfMs, sessionOpenMs); b <= prevBoundary && filled < 30; b += tfMs) {
        if (finalizedSet.has(b)) continue;
        if (active && active.openTime === b) continue;

        const syntheticCandle: Candle = {
          symbol,
          timeframe: tfStr,
          open: prevClose,
          high: prevClose,
          low: prevClose,
          close: prevClose,
          openTime: b,
          volume: 0,
          isSynthetic: true,
        };

        debugLog(`[MODULE1][BOUNDARY] Generated synthetic carry-forward candle for ${symbol} (${tfStr}) at ${new Date(b).toISOString()} (close=${prevClose}).`);
        await finaliseCandle(syntheticCandle);
        filled++;
      }
    }
  }
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
  // The minute the WALL CLOCK is currently in — used to tell "first tick of a
  // brand-new minute" (boundary === wallBoundary) apart from "late tick for a
  // minute that already closed" (boundary < wallBoundary).
  const wallBoundary = getBoundaryTime(new Date(), timeframeMinutes);
  let candle = activeCandles[symbol][timeframeStr];

  // Check if a synthetic candle was previously finalized for this boundary
  const cachedList = finalizedCandlesCache[symbol]?.[timeframeStr] || [];
  const syntheticIdx = cachedList.findIndex(c => c.openTime === boundary && c.isSynthetic);

  /**
   * A real tick arrived for a minute that was ALREADY finalized as a real
   * candle (feed-timestamp lag past the grace window, or a genuine
   * out-of-order delivery). Extend that finalized candle's high/low if this
   * trade fell outside the captured range, then re-persist it. NEVER recreate
   * an active candle for a past minute and NEVER reset open/close — that is
   * exactly what used to collapse a multi-tick candle into a flat bar.
   */
  const mergeLateTickIntoFinalizedReal = (): Candle | null => {
    const idx = cachedList.findIndex(c => c.openTime === boundary && !c.isSynthetic);
    if (idx < 0) return null;
    const fin = cachedList[idx];
    const newHigh = Math.max(fin.high, ltp);
    const newLow = Math.min(fin.low, ltp);
    if (newHigh === fin.high && newLow === fin.low) {
      // Nothing to change — the late tick is within the already-captured range.
      return fin;
    }
    fin.high = newHigh;
    fin.low = newLow;
    fin.volume += volume;
    debugLog(`[MODULE1][AGGREGATOR] Late real tick merged into finalized ${symbol} (${timeframeStr}) at ${new Date(boundary).toISOString()} — H/L extended to ${fin.high}/${fin.low}.`);
    queueForPersist({ ...fin });
    return fin;
  };

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
      debugLog(`[MODULE1][AGGREGATOR] Real tick arrived for synthetic candle ${symbol} (${timeframeStr}) at ${new Date(boundary).toISOString()} — replaced synthetic bar.`);
      candleAudit.set(syn, { ticks: 1, prices: new Set([ltp]), first: ltp, last: ltp });
      queueForPersist({ ...syn });
      candle = syn;
    } else if (!candle && boundary < wallBoundary) {
      // No active candle AND the tick's minute has already elapsed → it is a
      // late tick, not the opening tick of the current minute. If a real
      // finalized candle exists for it, merge; otherwise drop it rather than
      // create a bogus flat active candle for a past minute.
      const merged = mergeLateTickIntoFinalizedReal();
      if (merged) return merged;
      console.warn(`[MODULE1][AGGREGATOR] Late tick for ${symbol} (${timeframeStr}) minute ${new Date(boundary).toISOString()} with no candle to merge into — dropped (tickTime=${timestamp.toISOString()} wall=${new Date(wallBoundary).toISOString()}).`);
      return {
        symbol, timeframe: timeframeStr,
        open: ltp, high: ltp, low: ltp, close: ltp,
        openTime: boundary, volume, isSynthetic: false,
      };
    } else {
      // Initialize brand new real candle (opening tick of the current minute)
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
      candleAudit.set(candle, { ticks: 1, prices: new Set([ltp]), first: ltp, last: ltp });
    }
  } else if (candle.openTime === boundary) {
    // Update existing active candle in the current boundary interval
    candle.high = Math.max(candle.high, ltp);
    candle.low = Math.min(candle.low, ltp);
    candle.close = ltp;
    candle.volume += volume;
    candle.isSynthetic = false;
    const a = candleAudit.get(candle);
    if (a) { a.ticks += 1; a.prices.add(ltp); a.last = ltp; }
    else candleAudit.set(candle, { ticks: 1, prices: new Set([ltp]), first: candle.open, last: ltp });
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
      debugLog(`[MODULE1][AGGREGATOR] Late real tick arrived for synthetic candle ${symbol} (${timeframeStr}) at ${new Date(boundary).toISOString()} — replaced synthetic bar.`);
      queueForPersist({ ...syn });
      return syn;
    }

    // Late tick for an already-finalized REAL candle: extend its H/L if the
    // trade was outside the captured range; never touch the active candle.
    const merged = mergeLateTickIntoFinalizedReal();
    if (merged) return merged;

    console.warn(`[MODULE1][AGGREGATOR] Late/out-of-order tick for ${symbol} (${timeframeStr}): tickTime=${timestamp.toISOString()} boundary=${new Date(boundary).toISOString()} currentCandle=${new Date(candle.openTime).toISOString()} — no finalized candle to merge, dropped.`);
    return candle;
  }

  activeCandles[symbol][timeframeStr] = candle;

  // Diagnostic logger for 1m interval verification
  if (timeframeStr === "1m" && (symbol === "NIFTY-FUT" || symbol === "NIFTY-SPOT") && diagOhlc1mCount < MAX_DIAG_OHLC) {
    diagOhlc1mCount++;
    debugLog(
      `[MODULE1][TICK][1m #${diagOhlc1mCount}] symbol=${symbol} min=${new Date(boundary).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })} ` +
      `tick=${ltp} -> O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} vol=${candle.volume}`
    );
  }

  return candle;
};

// ── Phase 6/2: candle persistence — off the tick hot path AND decoupled from
//    pivot processing ─────────────────────────────────────────────────────────
//
// Phase 1 proved this was THE production bottleneck: drainPersistQueue used to
//   (a) splice the WHOLE queue into one unbounded batch,
//   (b) run a per-(symbol,timeframe) retention deleteMany (~4,560 awaited round
//       trips on the first session-start burst),
//   (c) then, still inside the same loop, AWAIT onCandleFinalized() → 3 pivot
//       inserts per real 1m/3m/5m candle (~1,000–2,100 sequential Mongo writes
//       per minute for the 456-instrument universe).
// The pipe fell 60–420s behind, the event loop starved, the Zebu WS dropped,
// and OOM restarts discarded every queued-but-unwritten candle → whole-minute
// blackouts for every symbol at once.
//
// Now:
//   • the batch is BOUNDED (MAX_PERSIST_BATCH) and the loop yields between
//     batches, so a burst is a series of small units of work, not one block.
//   • FuturesOHLC + Module1CandleArchive are the ONLY awaited writes here, and
//     a transient failure RE-QUEUES the batch with exponential backoff instead
//     of dropping it. Exhausted/permanent failures go to a bounded dead-letter
//     (kept in finalizedCandlesCache + logged loudly — never silently lost).
//   • retention is NOT done here — the bar_time TTL index (86,400s) and
//     module1DataCleanupService (boot + 5-min scheduler) both cover it.
//   • pivots are ENQUEUED (fire-and-forget, O(1)) onto pivotService's bounded
//     worker. If pivots fall behind, candle persistence is unaffected.

interface PersistItem { candle: Candle; at: number; attempts: number }

const persistQueue: PersistItem[] = [];
let draining = false;
let persistBackoffUntil = 0;
let _retryScheduled = false;

const MAX_PERSIST_BATCH = Number(process.env.MODULE1_PERSIST_BATCH_MAX) || 800;
const MAX_PERSIST_ATTEMPTS = Number(process.env.MODULE1_PERSIST_MAX_ATTEMPTS) || 8;
const DEAD_LETTER_MAX = 5000;

// Candles that exhausted MAX_PERSIST_ATTEMPTS or hit a permanent (schema/
// validation) error. Bounded + loudly logged so a permanent failure is never
// silently discarded; each also stays in finalizedCandlesCache and is still
// served by the API's in-memory fallback.
const persistDeadLetter: Candle[] = [];

let _persistErrCount = 0;
let _persistErrLastLog = 0;
let _persistOkCount = 0;
let _lastBatchSize = 0;
let _lastWriteMs = 0;
let _permanentFailureCount = 0;

export const getModule1PersistStats = () => ({
  queueDepth: persistQueue.length,
  oldestQueuedAgeMs: persistQueue.length > 0 ? Date.now() - persistQueue[0].at : 0,
  lastBatchSize: _lastBatchSize,
  lastWriteMs: _lastWriteMs,
  persisted: _persistOkCount,
  retryCount: _persistErrCount,
  permanentFailures: _permanentFailureCount,
  deadLetterSize: persistDeadLetter.length,
  backoffMs: Math.max(0, persistBackoffUntil - Date.now()),
  draining,
});

/** Test-only: reset all persistence counters + queues. */
export const __resetPersistForTest = (): void => {
  persistQueue.length = 0;
  persistDeadLetter.length = 0;
  draining = false;
  persistBackoffUntil = 0;
  _retryScheduled = false;
  _persistErrCount = _persistOkCount = _lastBatchSize = _lastWriteMs = _permanentFailureCount = 0;
};

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

// Test seam: substitute the Mongo candle write (FuturesOHLC + Archive) without a DB.
let _candleBatchWriter: ((batch: Candle[]) => Promise<void>) | null = null;
export const __setCandleBatchWriterForTest = (fn: ((batch: Candle[]) => Promise<void>) | null): void => {
  _candleBatchWriter = fn;
};

// A schema/validation/cast error is permanent — retrying it forever is pointless.
// Everything else (network, timeout, pool exhaustion, primary step-down) is transient.
const isTransientWriteError = (err: any): boolean => {
  const name = String(err?.name || "");
  if (name === "ValidationError" || name === "StrictModeError" || name === "CastError") return false;
  return true;
};

/** Persist one batch to FuturesOHLC + Module1CandleArchive. Throws on failure
 *  (idempotent upserts — a retried batch is harmless). */
const writeCandleBatch = async (batch: Candle[]): Promise<void> => {
  if (_candleBatchWriter) { await _candleBatchWriter(batch); return; }
  const realBatch = batch.filter(c => !c.isSynthetic);
  if (realBatch.length > 0) await archiveModule1Candles(realBatch);
  const bulkRes: any = await FuturesOHLC.bulkWrite(batch.map(candleToUpsertOp), { ordered: false });
  if (isOhlcAuditEnabled()) {
    auditLog(
      `[MODULE1][OHLC-AUDIT][PERSIST-RESULT] batch=${batch.length} ` +
      `upserted=${bulkRes?.upsertedCount ?? "?"} modified=${bulkRes?.modifiedCount ?? "?"} ` +
      `matched=${bulkRes?.matchedCount ?? "?"} mongo=${mongoConnectionStateName()}`
    );
    for (const c of batch) {
      if (c.timeframe !== "1m" || (c.symbol !== "NIFTY-FUT" && c.symbol !== "NIFTY-SPOT")) continue;
      const minuteIst = new Date(c.openTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
      auditLog(`[MODULE1][OHLC-AUDIT][PERSISTED] symbol=${c.symbol} minute=${minuteIst} persisted=${c.open}/${c.high}/${c.low}/${c.close} synthetic=${!!c.isSynthetic}`);
    }
  }
};

const scheduleDrainRetry = (delayMs: number): void => {
  if (_retryScheduled) return;
  _retryScheduled = true;
  setTimeout(() => { _retryScheduled = false; void drainPersistQueue(); }, Math.max(0, delayMs));
};

/** Hand a persisted batch's real candles to the bounded pivot worker. O(1) per
 *  candle, never awaited, never allowed to affect persistence. */
const enqueuePivotsFor = (batch: Candle[]): void => {
  if (!onCandleFinalized || !isMarketDataProcessingEnabled()) return;
  for (const c of batch) {
    if (c.isSynthetic) continue;
    try {
      void onCandleFinalized(c);
    } catch {
      /* pivot enqueue must never break candle persistence */
    }
  }
};

const drainPersistQueue = async () => {
  if (draining || !isMarketDataProcessingEnabled()) return;
  if (Date.now() < persistBackoffUntil) {
    scheduleDrainRetry(persistBackoffUntil - Date.now());
    return;
  }
  draining = true;
  try {
    while (persistQueue.length > 0) {
      if (!isMarketDataProcessingEnabled()) { persistQueue.length = 0; break; }

      const items = persistQueue.slice(0, MAX_PERSIST_BATCH);
      const batch = items.map(i => i.candle);
      _lastBatchSize = batch.length;

      const t0 = Date.now();
      try {
        await writeCandleBatch(batch);
        _lastWriteMs = Date.now() - t0;
        persistQueue.splice(0, items.length);
        _persistOkCount += batch.length;
        debugLog(`[MODULE1][PERSIST] Persisted ${batch.length} candle(s) (${_lastWriteMs}ms, queue=${persistQueue.length}).`);
        enqueuePivotsFor(batch);
      } catch (error: any) {
        _lastWriteMs = Date.now() - t0;
        const writeErrors: any[] = error?.writeErrors ?? [];
        const allDup =
          error?.code === 11000 ||
          (writeErrors.length > 0 && writeErrors.every((we: any) => we?.code === 11000));

        if (allDup) {
          // Every op was a duplicate key → the documents are already persisted.
          persistQueue.splice(0, items.length);
          _persistOkCount += batch.length;
          debugLog(`[MODULE1][PERSIST] Batch of ${batch.length} already present (duplicate-key) — treated as persisted.`);
          enqueuePivotsFor(batch);
          continue;
        }

        _persistErrCount++;
        const transient = isTransientWriteError(error);
        for (const it of items) it.attempts++;
        const exhausted = items.every(it => it.attempts >= MAX_PERSIST_ATTEMPTS);

        if (isOhlcAuditEnabled()) {
          auditLog(`[MODULE1][OHLC-AUDIT][PERSIST-FAIL] batch=${batch.length} transient=${transient} mongo=${mongoConnectionStateName()} err=${error?.message || error}`);
        }

        if (!transient || exhausted) {
          // Permanent, or transient-but-out-of-retries → dead-letter (bounded),
          // remove from the queue, keep going with the next batch. The candles
          // remain in finalizedCandlesCache so the API in-memory fallback still
          // serves them.
          persistQueue.splice(0, items.length);
          let dl = 0;
          for (const it of items) {
            if (persistDeadLetter.length < DEAD_LETTER_MAX) persistDeadLetter.push(it.candle);
            dl++;
          }
          _permanentFailureCount += dl;
          console.error(
            `[MODULE1][PERSIST][PERMANENT] ${dl} candle(s) ${transient ? "exhausted retries" : "hit a permanent error"} ` +
            `(mongo=${mongoConnectionStateName()}, err=${error?.message || error}) — moved to dead-letter ` +
            `(size ${persistDeadLetter.length}), kept in memory, NOT silently dropped.`
          );
          continue;
        }

        // Transient and retries remain → leave the batch in the queue, back off,
        // stop this drain. scheduleDrainRetry / the next finaliseCandle resumes.
        const now = Date.now();
        if (now - _persistErrLastLog > 10_000) {
          _persistErrLastLog = now;
          const attempt = Math.max(...items.map(it => it.attempts));
          console.error(
            `[MODULE1][PERSIST][ERROR] Batch of ${batch.length} failed (attempt ${attempt}/${MAX_PERSIST_ATTEMPTS}, ` +
            `${_persistErrCount} total, mongo=${mongoConnectionStateName()}): ${error?.message || error} — will retry.`
          );
        }
        const attempt = Math.max(...items.map(it => it.attempts));
        persistBackoffUntil = Date.now() + Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
        scheduleDrainRetry(persistBackoffUntil - Date.now());
        break;
      }

      // Yield the event loop between batches so a large burst can't monopolise it.
      if (persistQueue.length > 0) await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    draining = false;
  }
};

/** Test-only: drain synchronously to a terminal state, skipping the wall-clock
 *  backoff wait (the retry/requeue/dead-letter logic still runs in full). */
export const __flushPersistForTest = async (maxPasses = 200): Promise<void> => {
  for (let i = 0; i < maxPasses && persistQueue.length > 0; i++) {
    persistBackoffUntil = 0;
    _retryScheduled = false;
    await drainPersistQueue();
    await new Promise(r => setTimeout(r, 0));
  }
};

/** Enqueue a finalized candle for durable persistence and kick the drain. */
const queueForPersist = (candle: Candle): void => {
  persistQueue.push({ candle, at: Date.now(), attempts: 0 });
  void drainPersistQueue();
};

/**
 * Records a finalized candle in the in-memory cache (synchronously — readers see
 * it immediately) and queues it for background persistence + pivot recalc.
 */
const finaliseCandle = async (liveCandle: Candle) => {
  if (!isMarketDataProcessingEnabled()) return;

  // Diagnostic: emit the tick audit for this minute BEFORE the copy below
  // (the WeakMap is keyed on the live object).
  emitOhlcAuditLine(liveCandle);

  let candle: Candle = { ...liveCandle };
  const { symbol, timeframe } = candle;
  if (!finalizedCandlesCache[symbol]) finalizedCandlesCache[symbol] = {};
  if (!finalizedCandlesCache[symbol][timeframe]) finalizedCandlesCache[symbol][timeframe] = [];

  const existingIdx = finalizedCandlesCache[symbol][timeframe].findIndex(c => c.openTime === candle.openTime);
  if (existingIdx >= 0) {
    const existing = finalizedCandlesCache[symbol][timeframe][existingIdx];
    if (!existing.isSynthetic && !candle.isSynthetic) {
      // Both real: NEVER let a re-finalization shrink an already-captured
      // candle (the classic "flat bar overwrites the good multi-tick bar"
      // corruption). Merge conservatively — keep the original open, widen H/L,
      // keep whichever close/volume is larger-range / non-decreasing.
      const merged: Candle = {
        ...existing,
        open: existing.open,
        high: Math.max(existing.high, candle.high),
        low: Math.min(existing.low, candle.low),
        close: candle.close,
        volume: Math.max(existing.volume, candle.volume),
        isSynthetic: false,
      };
      const changed = merged.high !== existing.high || merged.low !== existing.low || merged.close !== existing.close;
      finalizedCandlesCache[symbol][timeframe][existingIdx] = merged;
      candle = merged;
      if (changed) {
        debugLog(`[MODULE1][AGGREGATOR] Re-finalization merged into existing real candle ${symbol} (${timeframe}) at ${new Date(candle.openTime).toISOString()} — O/H/L/C=${candle.open}/${candle.high}/${candle.low}/${candle.close}.`);
      }
    } else {
      // Existing synthetic (or new real replacing synthetic) — replace outright.
      finalizedCandlesCache[symbol][timeframe][existingIdx] = candle;
    }
  } else {
    finalizedCandlesCache[symbol][timeframe].push(candle);
    // Keep at most 400 candles in memory (enough for a full 1m intraday session: 375 candles)
    if (finalizedCandlesCache[symbol][timeframe].length > 400) {
      finalizedCandlesCache[symbol][timeframe].shift();
    }
  }

  queueForPersist(candle);
};

/**
 * [MODULE1][OHLC-AUDIT] — proves, per finalized 1-minute NIFTY-FUT / NIFTY-SPOT
 * candle, whether a flat (O=H=L=C) bar was a genuine single-price minute or the
 * result of ticks being lost between the pipeline and the aggregator.
 * No-op unless MODULE1_OHLC_AUDIT=true.
 */
const emitOhlcAuditLine = (candle: Candle) => {
  if (!isOhlcAuditEnabled()) return;
  if (candle.timeframe !== "1m") return;
  if (candle.symbol !== "NIFTY-FUT" && candle.symbol !== "NIFTY-SPOT") return;

  const a = candleAudit.get(candle);
  const pipe = getPipelineMinute(candle.symbol, candle.openTime);
  const minuteIst = new Date(candle.openTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  const flat = candle.open === candle.high && candle.high === candle.low && candle.low === candle.close;

  let classification: string;
  if (candle.isSynthetic) classification = "SYNTHETIC_NO_TICKS";
  else if (!flat) classification = "OK_MULTI_TICK";
  else if (pipe.pipelineTicks <= 1 && (a?.ticks ?? 1) <= 1) classification = "VALID_SINGLE_TICK";
  else if (pipe.uniquePrices <= 1) classification = "VALID_MULTI_TICK_SAME_PRICE";
  else classification = "INVALID_AGGREGATION"; // pipeline saw >1 distinct price but the candle is flat

  auditLog(
    `[MODULE1][OHLC-AUDIT] symbol=${candle.symbol} minute=${minuteIst} ` +
    `pipelineTicks=${pipe.pipelineTicks} pipelineUniquePrices=${pipe.uniquePrices} ` +
    `pipelineFirst=${pipe.firstPrice ?? "—"} pipelineLast=${pipe.lastPrice ?? "—"} ` +
    `aggregatorTicks=${a?.ticks ?? "—"} aggregatorUniquePrices=${a ? a.prices.size : "—"} ` +
    `aggregator=${candle.open}/${candle.high}/${candle.low}/${candle.close} ` +
    `synthetic=${!!candle.isSynthetic} classification=${classification}`
  );
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
