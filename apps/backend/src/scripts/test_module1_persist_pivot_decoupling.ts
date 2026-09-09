/**
 * Phase 2 regression: candle persistence is fully DECOUPLED from pivot
 * processing.
 *
 * Proves:
 *  1.  Processing the full 456-instrument universe does not explode the persist
 *      queue — it drains to empty.
 *  2.  A hung/blocked pivot worker cannot stop or delay candle persistence.
 *  3.  A failing pivot write does not prevent FuturesOHLC/Archive persistence.
 *  4.  A pivot BACKLOG (queue at cap) does not stop candle persistence; the
 *      pivot queue stays BOUNDED (drops with a counter — no unbounded growth).
 *  9.  No synthetic OPTION candles are ever generated.
 *  12. Module 2 is untouched (this test never imports a Module 2 module).
 *
 *   npx ts-node --transpile-only src/scripts/test_module1_persist_pivot_decoupling.ts
 */
import mongoose from "mongoose";
mongoose.set("bufferCommands", false); // no real DB — all writes are injected

import { enableMarketDataProcessing } from "../services/marketDataLifecycle";
import {
  aggregateOHLC,
  getCachedOHLCBars,
  stopBoundaryChecker,
  clearActiveCandles,
  getModule1PersistStats,
  __setCandleBatchWriterForTest,
  __resetPersistForTest,
  __flushPersistForTest,
} from "../services/ohlcAggregator";
import {
  initPivotService,
  stopPivotWorker,
  getPivotQueueStats,
  __setPivotBulkWriterForTest,
  __resetPivotQueueForTest,
  __setPivotQueueCapForTest,
  __drainPivotQueueForTest,
} from "../services/pivotService";
import type { Candle, Tick } from "@stock/shared";

stopBoundaryChecker();
enableMarketDataProcessing();

let passed = 0;
let failed = 0;
const ok = (n: string) => { passed++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d?: unknown) => { failed++; console.error(`  ✗ ${n}`, d ?? ""); };

const minute = Math.floor(Date.now() / 60000) * 60000;
const tk = (sym: string, ltp: number, tMs: number): Tick => ({ symbol: sym, ltp, timestamp: new Date(tMs), volume: 3 });

// Synthetic 456-instrument universe: FUT + SPOT + 227 CE + 227 PE (15SEP26).
const symbols: string[] = ["NIFTY-FUT", "NIFTY-SPOT"];
for (let s = 18400; s <= 29700; s += 50) { symbols.push(`NIFTY15SEP26C${s}`); symbols.push(`NIFTY15SEP26P${s}`); }

// Persisted-candle sink (stands in for FuturesOHLC + Module1CandleArchive).
const persisted = new Map<string, Candle>();
const key = (c: Candle) => `${c.symbol}|${c.timeframe}|${c.openTime}`;

async function fillTwoMinutesForEverySymbol() {
  // minute M: first tick; minute M+1: second tick → finalizes M for each symbol.
  for (const s of symbols) await aggregateOHLC(tk(s, 100, minute + 1_000), 1, "1m");
  for (const s of symbols) await aggregateOHLC(tk(s, 105, minute + 61_000), 1, "1m");
}

async function run() {
  console.log(`\n── universe: ${symbols.length} instruments (FUT + SPOT + ${(symbols.length - 2) / 2} CE + ${(symbols.length - 2) / 2} PE) ──`);
  if (symbols.length === 456) ok("456-instrument universe assembled (227 CE + 227 PE)");
  else bad("universe size wrong", symbols.length);

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── 2 & 4: a HUNG pivot worker cannot block/delay candle persistence ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    __resetPersistForTest();
    __resetPivotQueueForTest();
    persisted.clear();

    __setCandleBatchWriterForTest(async (batch) => {
      for (const c of batch) persisted.set(key(c), c);
    });
    // Pivot write that NEVER resolves — the worst-case blocked worker.
    let pivotWriteStarted = 0;
    __setPivotBulkWriterForTest(() => { pivotWriteStarted++; return new Promise<void>(() => {}); });
    initPivotService(); // registers onCandleFinalized → enqueuePivotRecalc, starts worker

    const t0 = Date.now();
    await fillTwoMinutesForEverySymbol();
    await __flushPersistForTest();
    const persistMs = Date.now() - t0;

    // give the (hung) pivot worker a couple of ticks to prove it can't help/hurt
    await new Promise(r => setTimeout(r, 60));

    const pstats = getModule1PersistStats();
    if (persisted.size === symbols.length) ok(`all ${symbols.length} minute-M candles persisted`);
    else bad("candles missing from persistence", { got: persisted.size, want: symbols.length });

    if (pstats.queueDepth === 0) ok("persist queue drained to empty despite hung pivot worker");
    else bad("persist queue not drained", pstats);

    if (persistMs < 4000) ok(`persistence finished fast (${persistMs}ms) — not blocked by pivots`);
    else bad("persistence was slow — pivot coupling suspected", persistMs);

    const cached = getCachedOHLCBars("NIFTY-FUT", "1m", 10);
    if (cached.some(b => b.openTime === minute)) ok("finalized FUT candle visible in in-memory cache immediately");
    else bad("FUT candle not in cache", cached);

    stopPivotWorker();
    __setPivotBulkWriterForTest(null);
    __setCandleBatchWriterForTest(null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── 3: a FAILING pivot write does not prevent candle persistence ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    __resetPersistForTest();
    __resetPivotQueueForTest();
    persisted.clear();

    __setCandleBatchWriterForTest(async (batch) => { for (const c of batch) persisted.set(key(c), c); });
    __setPivotBulkWriterForTest(() => Promise.reject(new Error("pivot mongo unreachable")));
    initPivotService();

    await fillTwoMinutesForEverySymbol();
    await __flushPersistForTest();
    await __drainPivotQueueForTest();

    if (persisted.size === symbols.length) ok(`all ${symbols.length} candles persisted while pivot writes fail`);
    else bad("candles lost when pivots failed", persisted.size);

    const pv = getPivotQueueStats();
    if (pv.writeErrors > 0) ok(`pivot write errors recorded (${pv.writeErrors}) — surfaced, not hidden`);
    else bad("pivot failure not recorded", pv);

    // jobs re-queue up to PIVOT_MAX_ATTEMPTS then are dropped → queue must not grow unbounded
    if (pv.queueDepth <= symbols.length) ok(`pivot queue bounded after repeated failure (depth ${pv.queueDepth})`);
    else bad("pivot queue grew unbounded on failure", pv);

    stopPivotWorker();
    __setPivotBulkWriterForTest(null);
    __setCandleBatchWriterForTest(null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── 1 & 4: pivot queue stays BOUNDED under a backlog (no OOM path) ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    __resetPersistForTest();
    __resetPivotQueueForTest();
    __setPivotQueueCapForTest(40);
    persisted.clear();

    __setCandleBatchWriterForTest(async (batch) => { for (const c of batch) persisted.set(key(c), c); });
    // Pivot write hangs → the worker can never drain → backlog builds.
    __setPivotBulkWriterForTest(() => new Promise<void>(() => {}));
    initPivotService();

    await fillTwoMinutesForEverySymbol();
    await __flushPersistForTest();
    await new Promise(r => setTimeout(r, 60));

    const pv = getPivotQueueStats();
    if (pv.queueDepth <= 40) ok(`pivot queue capped at 40 (depth ${pv.queueDepth}) — never unbounded`);
    else bad("pivot queue exceeded cap", pv);
    if (pv.dropped > 0) ok(`${pv.dropped} pivot job(s) dropped past the cap (counted, throttled-logged)`);
    else bad("expected drops past the cap", pv);
    if (persisted.size === symbols.length) ok(`all ${symbols.length} candles still persisted under pivot backlog`);
    else bad("candles lost under pivot backlog", persisted.size);

    stopPivotWorker();
    __setPivotBulkWriterForTest(null);
    __setCandleBatchWriterForTest(null);
    __setPivotQueueCapForTest(8000);
    __resetPivotQueueForTest();
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── 9: no synthetic OPTION candles are produced ──");
  {
    const synthOpt = [...persisted.values()].filter(c => /[CP]\d+$/.test(c.symbol) && c.isSynthetic);
    if (synthOpt.length === 0) ok("zero synthetic option candles across the whole run");
    else bad("synthetic option candle(s) leaked", synthOpt.slice(0, 3));
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} persist/pivot decoupling: ${passed} passed, ${failed} failed.`);
  stopPivotWorker();
  stopBoundaryChecker();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
