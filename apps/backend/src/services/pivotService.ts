import { FuturesOHLC } from "../models/FuturesOHLC";
import { PivotLevels as PivotLevelsModel } from "../models/PivotLevels";
import { setOnCandleFinalized } from "./ohlcAggregator";
import { readLive } from "./redisWriteBuffer";
import {
  calculateClassicPivot,
  calculateCamarillaPivot,
  calculateFibonacciPivot,
  getCallIndicator,
  getPutIndicator,
  getDivergence,
} from "../utils/pivotEngine";
import { isMarketDataProcessingEnabled } from "./marketDataLifecycle";
import { isOhlcAuditEnabled, auditLog } from "./module1OhlcAudit";
import { mongoConnectionStateName } from "../config/db";
import { Candle, PivotLevels, Module1Indicators } from "@stock/shared";

// Local cache for the latest computed pivots: latestPivots[symbol][timeframe][method]
const latestPivots: Record<string, Record<string, Record<string, PivotLevels>>> = {};

// The PivotLevels schema's `timeframe` enum is ["1m", "3m", "5m", "custom"].
// A finalized candle for any OTHER timeframe (2m/10m/15m/30m/45m/1h/2h/3h/4h —
// all of which dataFeed aggregates) is not a pivot timeframe. Skip up front so
// the pivot queue never grows with work that would be rejected anyway.
const PIVOT_TIMEFRAMES = new Set(["1m", "3m", "5m", "custom"]);

// Throttled failure logging — pivot writes fan out to hundreds of docs/minute,
// so a raw console.error per failure would flood, but total silence hid the bug.
let _pivotErrCount = 0;
let _pivotErrLastLog = 0;
const logPivotError = (context: string, err: any): void => {
  _pivotErrCount++;
  const now = Date.now();
  if (now - _pivotErrLastLog > 10_000) {
    _pivotErrLastLog = now;
    console.error(
      `[PivotService][ERROR] ${context} (${_pivotErrCount} failure(s) so far, mongo=${mongoConnectionStateName()}): ${err?.message || err}`
    );
  }
};

// Callback to trigger WebSocket broadcasts when pivots recalculate
type PivotsUpdatedCallback = (pivots: Record<string, PivotLevels>) => Promise<void> | void;
let onPivotsUpdated: PivotsUpdatedCallback | null = null;

export const setOnPivotsUpdated = (callback: PivotsUpdatedCallback) => {
  onPivotsUpdated = callback;
};

// ─────────────────────────────────────────────────────────────────────────────
// PIVOT COMPUTE + UPSERT
//
// Phase 2: pivots were the persistence bottleneck. Each finalized 1m/3m/5m
// candle used to fire 3 sequential PivotLevelsModel.create() calls AWAITED
// inside drainPersistQueue's finalize loop — ~1,000–2,100 individual inserts
// per minute for the 456-instrument universe (97k docs/session), blocking the
// candle-persistence pipeline and the event loop.
//
// Now:
//   • one document per (symbol, timeframe, method) — UPSERT, not insert. The
//     collection stops growing (≤ 456 × 4 × 3 ≈ 5.5k docs) and the reader
//     (getPivotLevels → latest) sees identical results.
//   • the whole drain batch is written with ONE PivotLevelsModel.bulkWrite().
//   • computation + write happen on a BOUNDED background worker (see below),
//     never on the candle-persistence path.
// ─────────────────────────────────────────────────────────────────────────────

interface PivotDoc {
  symbol: string;
  timeframe: string;
  method: "classic" | "camarilla" | "fibonacci";
  pivot: number;
  r1: number; r2: number; r3: number; r4?: number;
  s1: number; s2: number; s3: number; s4?: number;
  date: Date;
  computedAt: Date;
}

/** Pure: compute the 3 method docs for one candle. No I/O. */
const computePivotDocs = (
  symbol: string,
  timeframe: string,
  high: number,
  low: number,
  close: number
): { docs: PivotDoc[]; results: Record<string, PivotLevels> } => {
  const now = new Date();
  const classic = calculateClassicPivot(high, low, close);
  const camarilla = calculateCamarillaPivot(high, low, close);
  const fibonacci = calculateFibonacciPivot(high, low, close);

  const methods = [
    { name: "classic" as const, levels: classic },
    { name: "camarilla" as const, levels: camarilla },
    { name: "fibonacci" as const, levels: fibonacci },
  ];

  const docs: PivotDoc[] = [];
  const results: Record<string, PivotLevels> = {};

  for (const m of methods) {
    const pivot = "P" in m.levels ? (m.levels as any).P : close;
    const r4 = "R4" in m.levels ? (m.levels as any).R4 : undefined;
    const s4 = "S4" in m.levels ? (m.levels as any).S4 : undefined;
    docs.push({
      symbol, timeframe, method: m.name,
      pivot, r1: m.levels.R1, r2: m.levels.R2, r3: m.levels.R3, r4,
      s1: m.levels.S1, s2: m.levels.S2, s3: m.levels.S3, s4,
      date: now, computedAt: now,
    });
    results[m.name] = {
      symbol, timeframe, method: m.name,
      pivot, r1: m.levels.R1, r2: m.levels.R2, r3: m.levels.R3, r4,
      s1: m.levels.S1, s2: m.levels.S2, s3: m.levels.S3, s4,
      computedAt: now,
    };
  }
  return { docs, results };
};

/** One idempotent upsert op for a (symbol, timeframe, method) pivot doc. */
const pivotUpsertOp = (d: PivotDoc) => ({
  updateOne: {
    filter: { symbol: d.symbol, timeframe: d.timeframe, method: d.method },
    update: {
      $set: {
        pivot: d.pivot,
        r1: d.r1, r2: d.r2, r3: d.r3, r4: d.r4,
        s1: d.s1, s2: d.s2, s3: d.s3, s4: d.s4,
        date: d.date,
        computed_at: d.computedAt,
      },
    },
    upsert: true,
  },
});

// Test seam: lets a regression test substitute the Mongo write without a DB.
let _pivotBulkWriter: ((ops: any[]) => Promise<void>) | null = null;
export const __setPivotBulkWriterForTest = (fn: ((ops: any[]) => Promise<void>) | null): void => {
  _pivotBulkWriter = fn;
};

const writePivotOps = async (ops: any[]): Promise<void> => {
  if (ops.length === 0) return;
  if (_pivotBulkWriter) { await _pivotBulkWriter(ops); return; }
  await PivotLevelsModel.bulkWrite(ops, { ordered: false });
};

/** Update the in-memory latest-pivot cache and broadcast to WS rooms. Runs even
 *  when the DB write failed, so the dashboard keeps its levels during a Mongo blip
 *  (mirrors the pre-Phase-2 behavior where the cache was written regardless). */
const applyPivotResults = (results: Record<string, PivotLevels>): void => {
  for (const [method, lv] of Object.entries(results)) {
    if (!latestPivots[lv.symbol]) latestPivots[lv.symbol] = {};
    if (!latestPivots[lv.symbol][lv.timeframe]) latestPivots[lv.symbol][lv.timeframe] = {};
    latestPivots[lv.symbol][lv.timeframe][method] = lv;
  }
  if (onPivotsUpdated) {
    try {
      void Promise.resolve(onPivotsUpdated(results)).catch(() => {});
    } catch { /* broadcast is best-effort */ }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDED PIVOT QUEUE + WORKER
//
// Contract:
//   • enqueuePivotRecalc() is O(1), never awaits I/O, never throws.
//   • Jobs are COALESCED by (symbol|timeframe): only the newest H/L/C is kept.
//     Nothing reads pivot history, so a superseded minute's pivot is not needed.
//   • The queue is bounded. Over the limit → drop with a counter (throttled
//     warn), so a stalled Mongo can never grow it without bound (no OOM).
//   • A single worker drains it on a timer with NO overlap. Transient write
//     failures re-queue the job (bounded attempts) with exponential backoff.
//   • If pivots fall behind, candle persistence is completely unaffected — this
//     module is never on that path.
// ─────────────────────────────────────────────────────────────────────────────

interface PivotJob {
  symbol: string;
  timeframe: string;
  high: number;
  low: number;
  close: number;
  enqueuedAt: number;
  attempts: number;
}

const pivotQueue = new Map<string, PivotJob>(); // key: `${symbol}|${timeframe}`
let MAX_PIVOT_QUEUE = Number(process.env.MODULE1_PIVOT_QUEUE_MAX) || 8000;
const PIVOT_DRAIN_BATCH = Number(process.env.MODULE1_PIVOT_DRAIN_BATCH) || 400;
const PIVOT_WORKER_TICK_MS = Number(process.env.MODULE1_PIVOT_WORKER_TICK_MS) || 250;
const PIVOT_MAX_ATTEMPTS = 5;

let pivotEnqueued = 0;
let pivotProcessed = 0;
let pivotDropped = 0;      // shed at the queue cap (backpressure)
let pivotExhausted = 0;    // gave up after PIVOT_MAX_ATTEMPTS (next candle re-computes)
let pivotWriteErrors = 0;
let pivotRetries = 0;
let lastPivotWriteMs = 0;
let lastPivotBatchSize = 0;
let _pivotDropLastLog = 0;

export const enqueuePivotRecalc = (candle: Candle): void => {
  if (candle.isSynthetic) return;
  if (!PIVOT_TIMEFRAMES.has(candle.timeframe)) {
    if (isOhlcAuditEnabled()) {
      auditLog(`[MODULE1][PIVOT-AUDIT][SKIP] ${candle.symbol} (${candle.timeframe}) — not a pivot timeframe.`);
    }
    return;
  }
  const key = `${candle.symbol}|${candle.timeframe}`;
  if (!pivotQueue.has(key) && pivotQueue.size >= MAX_PIVOT_QUEUE) {
    pivotDropped++;
    const now = Date.now();
    if (now - _pivotDropLastLog > 10_000) {
      _pivotDropLastLog = now;
      console.warn(
        `[MODULE1][PIVOT] Queue at cap (${MAX_PIVOT_QUEUE}) — dropped ${pivotDropped} pivot job(s) so far. ` +
        `Pivots are lagging; candle persistence is unaffected.`
      );
    }
    return;
  }
  pivotQueue.set(key, {
    symbol: candle.symbol,
    timeframe: candle.timeframe,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    enqueuedAt: Date.now(),
    attempts: 0,
  });
  pivotEnqueued++;
};

let pivotWorkerTimer: NodeJS.Timeout | null = null;
let pivotWorkerRunning = false;
let pivotBackoffUntil = 0;

const runPivotWorkerOnce = async (): Promise<void> => {
  if (pivotWorkerRunning) return;
  if (Date.now() < pivotBackoffUntil) return;
  if (pivotQueue.size === 0) return;
  if (!isMarketDataProcessingEnabled()) { pivotQueue.clear(); return; }

  pivotWorkerRunning = true;
  try {
    const jobs: PivotJob[] = [];
    for (const [k, j] of pivotQueue) {
      jobs.push(j);
      pivotQueue.delete(k);
      if (jobs.length >= PIVOT_DRAIN_BATCH) break;
    }
    if (jobs.length === 0) return;

    const ops: any[] = [];
    const resultSets: Record<string, PivotLevels>[] = [];
    for (const j of jobs) {
      const { docs, results } = computePivotDocs(j.symbol, j.timeframe, j.high, j.low, j.close);
      resultSets.push(results);
      for (const d of docs) ops.push(pivotUpsertOp(d));
    }

    const t0 = Date.now();
    try {
      await writePivotOps(ops);
      lastPivotWriteMs = Date.now() - t0;
      lastPivotBatchSize = jobs.length;
      pivotProcessed += jobs.length;
      for (const r of resultSets) applyPivotResults(r);
    } catch (err: any) {
      lastPivotWriteMs = Date.now() - t0;
      const writeErrors: any[] = err?.writeErrors ?? [];
      const allDup = writeErrors.length > 0 && writeErrors.every((w: any) => w?.code === 11000);
      if (allDup) {
        // Upsert + unique-key race on a concurrent writer — the data is in. Not a failure.
        pivotProcessed += jobs.length;
        for (const r of resultSets) applyPivotResults(r);
      } else {
        pivotWriteErrors++;
        logPivotError(`pivot bulkWrite (batch=${jobs.length})`, err);
        // Keep the dashboard's levels fresh even while Mongo is unreachable.
        for (const r of resultSets) applyPivotResults(r);
        // Re-queue transient failures, bounded. A newer candle for the same key
        // supersedes the retry (do not clobber fresher data).
        let requeued = 0;
        for (const j of jobs) {
          j.attempts++;
          if (j.attempts > PIVOT_MAX_ATTEMPTS) { pivotExhausted++; continue; }
          const key = `${j.symbol}|${j.timeframe}`;
          if (pivotQueue.has(key)) continue; // a fresher candle already superseded it
          if (pivotQueue.size >= MAX_PIVOT_QUEUE) { pivotDropped++; continue; }
          pivotQueue.set(key, j);
          requeued++;
        }
        pivotRetries += requeued;
        const attempt = Math.min(...jobs.map(j => j.attempts));
        pivotBackoffUntil = Date.now() + Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
      }
    }
  } finally {
    pivotWorkerRunning = false;
  }
};

export const startPivotWorker = (): void => {
  if (pivotWorkerTimer) return;
  pivotWorkerTimer = setInterval(() => { void runPivotWorkerOnce(); }, PIVOT_WORKER_TICK_MS);
  console.log(
    `[MODULE1][PIVOT] Worker started — coalesced queue (cap ${MAX_PIVOT_QUEUE}), ` +
    `drain ≤ ${PIVOT_DRAIN_BATCH}/tick every ${PIVOT_WORKER_TICK_MS}ms, one bulkWrite per drain.`
  );
};

export const stopPivotWorker = (): void => {
  if (pivotWorkerTimer) {
    clearInterval(pivotWorkerTimer);
    pivotWorkerTimer = null;
  }
};

/** Test-only: run the worker to a terminal state, skipping the wall-clock
 *  backoff wait (retry/requeue/drop logic still runs in full). */
export const __drainPivotQueueForTest = async (maxPasses = 100): Promise<void> => {
  for (let i = 0; i < maxPasses && pivotQueue.size > 0; i++) {
    pivotBackoffUntil = 0;
    await runPivotWorkerOnce();
    await new Promise(r => setTimeout(r, 0));
  }
};

/** Test-only: shrink the queue cap so a bounded-growth assertion is fast. */
export const __setPivotQueueCapForTest = (n: number): void => {
  MAX_PIVOT_QUEUE = n;
};

export const getPivotQueueStats = () => ({
  queueDepth: pivotQueue.size,
  enqueued: pivotEnqueued,
  processed: pivotProcessed,
  dropped: pivotDropped,
  exhausted: pivotExhausted,
  writeErrors: pivotWriteErrors,
  retries: pivotRetries,
  lastWriteMs: lastPivotWriteMs,
  lastBatchSize: lastPivotBatchSize,
  backoffMs: Math.max(0, pivotBackoffUntil - Date.now()),
});

/** Test-only: reset all queue state. */
export const __resetPivotQueueForTest = (): void => {
  pivotQueue.clear();
  pivotEnqueued = pivotProcessed = pivotDropped = pivotExhausted = pivotWriteErrors = pivotRetries = 0;
  lastPivotWriteMs = lastPivotBatchSize = 0;
  pivotBackoffUntil = 0;
  pivotWorkerRunning = false;
};

/**
 * Initialize pivot service and register the finalized-candle listener.
 *
 * The listener is now a fire-and-forget ENQUEUE — it never awaits I/O, so the
 * candle-persistence loop that invokes it (ohlcAggregator.drainPersistQueue)
 * can never be blocked or starved by pivot work.
 */
export const initPivotService = () => {
  setOnCandleFinalized((candle: Candle) => {
    if (!isMarketDataProcessingEnabled()) return;
    enqueuePivotRecalc(candle);
  });
  startPivotWorker();
};

/**
 * Recalculates pivots (all 3 methods) for one candle and upserts them in ONE
 * bulkWrite. Retained for the direct-call fallback path (getPivotLevels below,
 * when neither the cache nor the DB has a pivot yet). The live per-minute path
 * goes through the bounded worker instead.
 */
export const recalculatePivots = async (
  symbol: string,
  timeframe: string,
  high: number,
  low: number,
  close: number
): Promise<Record<string, PivotLevels>> => {
  if (!isMarketDataProcessingEnabled()) return {};
  // Guard the DB path too — getPivotLevels()'s "recompute from last candle"
  // fallback calls this directly, bypassing the listener's timeframe filter.
  if (!PIVOT_TIMEFRAMES.has(timeframe)) return {};

  const { docs, results } = computePivotDocs(symbol, timeframe, high, low, close);

  try {
    await writePivotOps(docs.map(pivotUpsertOp));
    if (isOhlcAuditEnabled()) {
      auditLog(`[MODULE1][PIVOT-AUDIT][WRITE] symbol=${symbol} tf=${timeframe} methods=3 mongo=${mongoConnectionStateName()}`);
    }
  } catch (err) {
    logPivotError(`recalculatePivots.bulkWrite(${symbol}/${timeframe})`, err);
  }

  applyPivotResults(results);
  return results;
};

/**
 * Gets cached pivot levels or loads them from MongoDB if cache is empty
 */
export const getPivotLevels = async (
  symbol: string,
  timeframe: string,
  method: "classic" | "camarilla" | "fibonacci"
): Promise<PivotLevels | null> => {
  // Check local cache
  if (latestPivots[symbol]?.[timeframe]?.[method]) {
    return latestPivots[symbol][timeframe][method];
  }

  // Fetch from database
  let doc = null;
  try {
    doc = await PivotLevelsModel.findOne({ symbol, timeframe, method }).sort({ computed_at: -1 });
  } catch (err) {
    // Suppress warning when offline
  }

  if (doc) {
    const levels: PivotLevels = {
      symbol: doc.symbol,
      timeframe: doc.timeframe,
      method: doc.method as any,
      pivot: doc.pivot,
      r1: doc.r1,
      r2: doc.r2,
      r3: doc.r3,
      r4: doc.r4 ?? undefined,
      s1: doc.s1,
      s2: doc.s2,
      s3: doc.s3,
      s4: doc.s4 ?? undefined,
      computedAt: doc.computed_at,
    };

    if (!latestPivots[symbol]) latestPivots[symbol] = {};
    if (!latestPivots[symbol][timeframe]) latestPivots[symbol][timeframe] = {};
    latestPivots[symbol][timeframe][method] = levels;

    return levels;
  }

  // Fallback: If no pivot exists in DB, fetch the last completed candle to calculate pivots
  let lastCandle = null;
  try {
    lastCandle = await FuturesOHLC.findOne({ symbol, timeframe }).sort({ bar_time: -1 });
  } catch (err) {
    // Suppress warning when offline
  }

  if (lastCandle) {
    const computed = await recalculatePivots(
      symbol,
      timeframe,
      lastCandle.bar_high,
      lastCandle.bar_low,
      lastCandle.bar_close
    );
    return computed[method];
  } else {
    // Fallback: Calculate pivots using the current cached LTP if DB is offline
    const rawFutLtp = await readLive(`ltp:${symbol}`);
    const currentPrice = rawFutLtp ? parseFloat(rawFutLtp) : 22100;
    const computed = await recalculatePivots(
      symbol,
      timeframe,
      currentPrice + 50,
      currentPrice - 50,
      currentPrice
    );
    return computed[method];
  }

  return null;
};

/**
 * Evaluates current indicators (Call/Put states) for a symbol, timeframe and pivot method
 */
export const evaluateIndicators = async (
  symbol: string,
  timeframe: string,
  method: "classic" | "camarilla" | "fibonacci",
  spotSymbol = "NIFTY-SPOT"
): Promise<Module1Indicators | null> => {
  try {
    // 1. Fetch latest prices — memory-first (this runs up to 2×/sec per active
    // indicator room; per-eval Redis GETs were pure quota waste).
    const rawFutLtp = await readLive(`ltp:${symbol}`);
    const rawSpotLtp = await readLive(`ltp:${spotSymbol}`);

    if (!rawFutLtp || !rawSpotLtp) {
      return null;
    }

    const futLtp = parseFloat(rawFutLtp);
    const spotLtp = parseFloat(rawSpotLtp);

    // 2. Fetch the active pivots
    const pivots = await getPivotLevels(symbol, timeframe, method);
    if (!pivots) {
      return null;
    }

    // 3. Compute indicators
    const divergencePct = getDivergence(spotLtp, futLtp);
    const callState = getCallIndicator(
      futLtp,
      { P: pivots.pivot, R1: pivots.r1, S1: pivots.s1 },
      spotLtp
    );
    const putState = getPutIndicator(
      futLtp,
      { P: pivots.pivot, R1: pivots.r1, S1: pivots.s1 },
      spotLtp
    );

    return {
      symbol,
      callState,
      putState,
      divergencePct,
      hasDivergenceWarning: divergencePct > 0.5,
      computedAt: new Date(),
    };
  } catch (error) {
    console.error("Error evaluating indicators:", error);
    return null;
  }
};
