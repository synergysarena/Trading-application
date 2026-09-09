/**
 * Regression: Module 1's FUT/SPOT candle timeline must have NO gaps — once the
 * feed has started, every elapsed session minute has a candle (real or
 * synthetic carry-forward). A hole here surfaces in the UI as a missing
 * worksheet row (worse: one that appears on strike switch).
 *
 * Previously fillContinuityCandles only ever considered the single minute
 * before "now" and bailed whenever ANY active candle existed, so a multi-minute
 * quiet stretch left a permanent gap.
 *
 *   npx ts-node --transpile-only src/scripts/test_module1_timeline_continuity.ts
 */
import mongoose from "mongoose";
mongoose.set("bufferCommands", false); // writes fail fast; we assert the in-memory cache

import { enableMarketDataProcessing } from "../services/marketDataLifecycle";
import {
  aggregateOHLC,
  getCachedOHLCBars,
  fillContinuityCandles,
  stopBoundaryChecker,
  clearActiveCandles,
  getTodaySessionOpenMs,
} from "../services/ohlcAggregator";
import type { Tick } from "@stock/shared";

stopBoundaryChecker();
enableMarketDataProcessing();

let passed = 0;
let failed = 0;
const ok = (n: string) => { passed++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d?: unknown) => { failed++; console.error(`  ✗ ${n}`, d ?? ""); };

const tk = (sym: string, ltp: number, tMs: number): Tick => ({
  symbol: sym, ltp, timestamp: new Date(tMs), volume: 1,
});

async function run() {
  const sessionOpen = getTodaySessionOpenMs();
  const wall = Math.floor(Date.now() / 60000) * 60000;         // current clock minute
  const at = (k: number) => wall + k * 60000;

  console.log("\n── a multi-minute quiet stretch is fully back-filled (no gap) ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    // real tick this minute → active candle for `wall`
    await aggregateOHLC(tk("NIFTY-FUT", 800, wall + 3_000), 1, "1m");
    // roll to next minute → finalizes `wall` (real), opens active for wall+1
    await aggregateOHLC(tk("NIFTY-FUT", 801, at(1) + 1_000), 1, "1m");

    // Simulate that 6 minutes have now elapsed with ZERO further ticks.
    await fillContinuityCandles(at(6) + 500, sessionOpen);

    const bars = getCachedOHLCBars("NIFTY-FUT", "1m", 400);
    const times = new Set(bars.map(b => b.openTime));

    // prevBoundary for now=wall+6 is wall+5 → synthetics expected for wall+2..wall+5
    const wantSyn = [2, 3, 4, 5].map(at);
    const missing = wantSyn.filter(t => !times.has(t));
    if (missing.length === 0) ok("candles present for every minute wall+2 … wall+5");
    else bad("timeline has holes", missing.map(t => new Date(t).toISOString()));

    const syn = bars.filter(b => wantSyn.includes(b.openTime));
    // carry-forward price = last known FUT close (the wall+1 tick, ltp 801)
    if (syn.length === 4 && syn.every(b => b.isSynthetic && b.open === 801 && b.open === b.high && b.high === b.low && b.low === b.close)) {
      ok("all four are flat synthetic carry-forward bars at the last known close (801)");
    } else bad("carry-forward bars malformed", syn);

    // idempotent — running again adds nothing
    const before = getCachedOHLCBars("NIFTY-FUT", "1m", 400).length;
    await fillContinuityCandles(at(6) + 900, sessionOpen);
    const after = getCachedOHLCBars("NIFTY-FUT", "1m", 400).length;
    if (before === after) ok(`idempotent — second pass added 0 (stayed ${after})`);
    else bad("second pass duplicated candles", { before, after });
  }

  console.log("\n── the finalized REAL candle is never overwritten by a synthetic ──");
  {
    const bars = getCachedOHLCBars("NIFTY-FUT", "1m", 400);
    const real = bars.find(b => b.openTime === wall);
    if (real && !real.isSynthetic && real.close === 800) ok("wall's real candle survived the fill (close 800, not synthetic)");
    else bad("real candle clobbered / missing", real);
  }

  console.log("\n── SPOT gets the same gap-free treatment ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    await aggregateOHLC(tk("NIFTY-SPOT", 24000, wall + 2_000), 1, "1m");
    await aggregateOHLC(tk("NIFTY-SPOT", 24001, at(1) + 1_000), 1, "1m");
    await fillContinuityCandles(at(4) + 500, sessionOpen);
    const times = new Set(getCachedOHLCBars("NIFTY-SPOT", "1m", 400).map(b => b.openTime));
    if ([2, 3].map(at).every(t => times.has(t))) ok("NIFTY-SPOT wall+2, wall+3 back-filled");
    else bad("SPOT timeline has holes");
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} timeline continuity: ${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
