/**
 * Phase 2 regression: a transient Mongo failure must NOT permanently lose a
 * finalized candle, and a failed batch must NEVER be silently discarded.
 *
 * Proves:
 *  5.  Transient write failure retries and eventually persists.
 *  6.  A batch that exhausts retries is moved to a bounded dead-letter (counted,
 *      loudly logged, kept in the in-memory cache) — never silently dropped.
 *  7.  Duplicate candles remain idempotent (E11000-only failure = success).
 *  7b. A permanent (schema/validation) error is NOT retried forever.
 *
 *   npx ts-node --transpile-only src/scripts/test_module1_persist_retry.ts
 */
import mongoose from "mongoose";
mongoose.set("bufferCommands", false);

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
import type { Tick } from "@stock/shared";

stopBoundaryChecker();
enableMarketDataProcessing();

let passed = 0;
let failed = 0;
const ok = (n: string) => { passed++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d?: unknown) => { failed++; console.error(`  ✗ ${n}`, d ?? ""); };

const minute = Math.floor(Date.now() / 60000) * 60000;
const tk = (sym: string, ltp: number, tMs: number): Tick => ({ symbol: sym, ltp, timestamp: new Date(tMs), volume: 2 });

// Finalize one 1m candle for `sym` at `minute` by crossing into minute+1.
async function finalizeOne(sym: string, ltp = 100) {
  await aggregateOHLC(tk(sym, ltp, minute + 1_000), 1, "1m");
  await aggregateOHLC(tk(sym, ltp + 5, minute + 61_000), 1, "1m");
}

const transientErr = () => Object.assign(new Error("connection 6 to cluster timed out"), { name: "MongoNetworkError" });
const dupErr = () => Object.assign(new Error("E11000 duplicate key"), {
  code: 11000,
  writeErrors: [{ code: 11000 }, { code: 11000 }],
});
const permanentErr = () => Object.assign(new Error("bar_close: Path `bar_close` is required."), { name: "ValidationError" });

async function run() {
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── 5: transient failure retries, then persists (no loss) ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    __resetPersistForTest();
    const persisted: string[] = [];
    let calls = 0;
    __setCandleBatchWriterForTest(async (batch) => {
      calls++;
      if (calls <= 3) throw transientErr();       // fail the first 3 attempts
      for (const c of batch) persisted.push(`${c.symbol}|${c.openTime}`);
    });

    await finalizeOne("NIFTY-FUT");
    await __flushPersistForTest();

    if (persisted.length === 1) ok(`candle persisted after ${calls} attempts (3 transient failures survived)`);
    else bad("candle lost across transient failures", { persisted, calls });

    const s = getModule1PersistStats();
    if (s.retryCount >= 3) ok(`retry count recorded (${s.retryCount})`);
    else bad("retries not counted", s);
    if (s.queueDepth === 0 && s.deadLetterSize === 0) ok("queue empty, nothing dead-lettered");
    else bad("unexpected residue", s);

    __setCandleBatchWriterForTest(null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── 6: exhausted retries → bounded dead-letter, NOT silent drop ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    __resetPersistForTest();
    __setCandleBatchWriterForTest(async () => { throw transientErr(); }); // always fails

    await finalizeOne("NIFTY-SPOT", 24000);
    await __flushPersistForTest();

    const s = getModule1PersistStats();
    if (s.queueDepth === 0) ok("queue not stuck — batch removed after exhausting retries");
    else bad("queue jammed on permanent transient failure", s);
    if (s.permanentFailures >= 1 && s.deadLetterSize >= 1) ok(`candle moved to dead-letter (permFail=${s.permanentFailures}, dl=${s.deadLetterSize}) — not silently dropped`);
    else bad("candle silently discarded", s);

    // still readable from the in-memory cache (API in-memory fallback path)
    const cached = getCachedOHLCBars("NIFTY-SPOT", "1m", 10);
    if (cached.some(b => b.openTime === minute)) ok("dead-lettered candle still served from in-memory cache");
    else bad("dead-lettered candle vanished from cache", cached);

    __setCandleBatchWriterForTest(null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── 7: duplicate-key-only failure is treated as success (idempotent) ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    __resetPersistForTest();
    let calls = 0;
    __setCandleBatchWriterForTest(async () => { calls++; throw dupErr(); });

    await finalizeOne("NIFTY-FUT");
    await __flushPersistForTest();

    const s = getModule1PersistStats();
    if (calls === 1) ok("duplicate-key failure NOT retried (already persisted)");
    else bad("duplicate-key failure was retried", calls);
    if (s.persisted >= 1 && s.deadLetterSize === 0 && s.queueDepth === 0) ok("counted as persisted, nothing dead-lettered");
    else bad("duplicate-key handling wrong", s);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── 7b: permanent (validation) error is dead-lettered immediately, not retried ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    __resetPersistForTest();
    let calls = 0;
    __setCandleBatchWriterForTest(async () => { calls++; throw permanentErr(); });

    await finalizeOne("NIFTY-SPOT", 24010);
    await __flushPersistForTest();

    const s = getModule1PersistStats();
    if (calls === 1) ok("permanent error not retried (1 attempt only)");
    else bad("permanent error was retried", calls);
    if (s.permanentFailures >= 1 && s.deadLetterSize >= 1) ok("permanent-error candle dead-lettered + counted");
    else bad("permanent error mishandled", s);
    if (s.queueDepth === 0) ok("queue clear after permanent error");
    else bad("queue stuck on permanent error", s);

    __setCandleBatchWriterForTest(null);
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} persist retry/durability: ${passed} passed, ${failed} failed.`);
  stopBoundaryChecker();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
