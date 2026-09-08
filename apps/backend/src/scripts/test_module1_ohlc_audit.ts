/**
 * Module 1 OHLC — audit-instrumentation + real-aggregator sanity checks.
 *   npx ts-node --transpile-only apps/backend/src/scripts/test_module1_ohlc_audit.ts
 *
 * Wall-clock-independent. The grace-period / late-tick-merge behaviour is
 * covered by the mirrored simulator suite in
 * apps/frontend/src/__tests__/ohlcAggregatorLogic.test.ts.
 */
process.env.MODULE1_OHLC_AUDIT = "true";
import assert from "assert";
import {
  isOhlcAuditEnabled,
  recordPipelineTick,
  getPipelineMinute,
  __resetOhlcAudit,
} from "../services/module1OhlcAudit";
import { enableMarketDataProcessing } from "../services/marketDataLifecycle";
import { aggregateOHLC, getActiveCandle, stopBoundaryChecker, clearActiveCandles } from "../services/ohlcAggregator";
import type { Tick } from "@stock/shared";

stopBoundaryChecker(); // no timer interference during the test
enableMarketDataProcessing();

let passed = 0;
const ok = (n: string) => { passed++; console.log(`  ✓ ${n}`); };

const capture = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { lines.push(a.join(" ")); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
};

async function run() {
  console.log("\n── module1OhlcAudit pure helpers ──");
  {
    __resetOhlcAudit();
    assert.strictEqual(isOhlcAuditEnabled(), true);
    const minute = Math.floor(Date.now() / 60000) * 60000;
    recordPipelineTick("NIFTY-FUT", minute + 1000, 100);
    recordPipelineTick("NIFTY-FUT", minute + 5000, 100);
    recordPipelineTick("NIFTY-FUT", minute + 9000, 102);
    const a = getPipelineMinute("NIFTY-FUT", minute);
    assert.strictEqual(a.pipelineTicks, 3);
    assert.strictEqual(a.uniquePrices, 2);
    assert.strictEqual(a.firstPrice, 100);
    assert.strictEqual(a.lastPrice, 102);
    ok("recordPipelineTick / getPipelineMinute bucket per clock-minute");

    const empty = getPipelineMinute("NIFTY-FUT", minute - 600000);
    assert.strictEqual(empty.pipelineTicks, 0);
    ok("unknown minute returns a zeroed audit (no throw)");
  }

  console.log("\n── real aggregator: multiple distinct ticks in one minute accumulate H/L ──");
  {
    clearActiveCandles(); enableMarketDataProcessing();
    const now = Date.now();
    const t = (offsetMs: number, ltp: number): Tick => ({
      symbol: "NIFTY-FUT", ltp, timestamp: new Date(now - (now % 60000) + offsetMs), volume: 10,
    });
    await aggregateOHLC(t(2000, 100), 1, "1m");
    await aggregateOHLC(t(8000, 104), 1, "1m");
    await aggregateOHLC(t(15000, 97), 1, "1m");
    await aggregateOHLC(t(40000, 101), 1, "1m");
    const c = getActiveCandle("NIFTY-FUT", "1m")!;
    assert.strictEqual(c.open, 100, "open = first tick");
    assert.strictEqual(c.high, 104, "high = max tick");
    assert.strictEqual(c.low, 97, "low = min tick");
    assert.strictEqual(c.close, 101, "close = last tick");
    assert.strictEqual(c.volume, 40);
    ok("4 distinct-price ticks in a minute → O=100 H=104 L=97 C=101 (aggregator does NOT collapse)");
  }

  console.log("\n── [MODULE1][OHLC-AUDIT] line is emitted on finalization with a classification ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); __resetOhlcAudit();
    // Use the CURRENT clock minute so the candle is active, then roll it over
    // with a next-minute tick (which finalizes the current-minute candle).
    const mkMin = Math.floor(Date.now() / 60000) * 60000;
    recordPipelineTick("NIFTY-SPOT", mkMin + 1000, 24000);
    recordPipelineTick("NIFTY-SPOT", mkMin + 20000, 24010);
    recordPipelineTick("NIFTY-SPOT", mkMin + 50000, 24005);

    const lines = await capture(async () => {
      await aggregateOHLC({ symbol: "NIFTY-SPOT", ltp: 24000, timestamp: new Date(mkMin + 1000), volume: 1 }, 1, "1m");
      await aggregateOHLC({ symbol: "NIFTY-SPOT", ltp: 24010, timestamp: new Date(mkMin + 20000), volume: 1 }, 1, "1m");
      await aggregateOHLC({ symbol: "NIFTY-SPOT", ltp: 24005, timestamp: new Date(mkMin + 50000), volume: 1 }, 1, "1m");
      // rollover tick in the NEXT minute → finalizes the mkMin candle
      await aggregateOHLC({ symbol: "NIFTY-SPOT", ltp: 24006, timestamp: new Date(mkMin + 65000), volume: 1 }, 1, "1m");
    });

    const auditLine = lines.find((l) => l.includes("[MODULE1][OHLC-AUDIT]") && l.includes("NIFTY-SPOT") && !l.includes("PERSISTED"));
    assert.ok(auditLine, "an OHLC-AUDIT line was emitted for the finalized minute");
    assert.ok(auditLine!.includes("pipelineTicks=3"), `pipelineTicks=3 in: ${auditLine}`);
    assert.ok(auditLine!.includes("pipelineUniquePrices=3"), `pipelineUniquePrices=3 in: ${auditLine}`);
    assert.ok(auditLine!.includes("aggregator=24000/24010/24000/24005"), `correct OHLC in: ${auditLine}`);
    assert.ok(auditLine!.includes("classification=OK_MULTI_TICK"), `classified OK_MULTI_TICK in: ${auditLine}`);
    ok("audit line reports pipeline vs aggregator counts + OHLC + classification");
  }

  console.log("\n── flat candle with >1 distinct pipeline price is flagged INVALID_AGGREGATION ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); __resetOhlcAudit();
    const mkMin = Math.floor(Date.now() / 60000) * 60000;
    // Pipeline saw movement…
    recordPipelineTick("NIFTY-FUT", mkMin + 1000, 500);
    recordPipelineTick("NIFTY-FUT", mkMin + 30000, 512);
    recordPipelineTick("NIFTY-FUT", mkMin + 55000, 505);
    const lines = await capture(async () => {
      // …but only ONE tick reaches the aggregator (simulating the lost-tick failure mode)
      await aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 500, timestamp: new Date(mkMin + 1000), volume: 1 }, 1, "1m");
      await aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 507, timestamp: new Date(mkMin + 65000), volume: 1 }, 1, "1m"); // rollover
    });
    const auditLine = lines.find((l) => l.includes("[MODULE1][OHLC-AUDIT]") && l.includes("NIFTY-FUT") && !l.includes("PERSISTED"));
    assert.ok(auditLine, "audit line emitted");
    assert.ok(auditLine!.includes("classification=INVALID_AGGREGATION"), `flagged INVALID_AGGREGATION in: ${auditLine}`);
    ok("pipeline had 3 distinct prices but candle is flat → INVALID_AGGREGATION");
  }

  console.log(`\n✅ All ${passed} Module 1 OHLC audit assertions passed.\n`);
}

run().then(() => process.exit(0)).catch((e) => { console.error("\n❌ FAILURE:\n", e); process.exit(1); });
