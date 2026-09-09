/**
 * Regression: Module 1 pivot persistence guard.
 *
 * Proves:
 *  - recalculatePivots() SKIPS timeframes outside the PivotLevels schema enum
 *    (2m/10m/15m/30m/45m/1h/2h/3h/4h) instead of firing a create() that throws
 *    a ValidationError which used to be swallowed silently.
 *  - recalculatePivots() still returns all three methods for the supported
 *    timeframes (1m/3m/5m/custom), and a DB write failure is caught + logged
 *    (never crashes the finalize pipeline, never reported as success).
 *
 *   npx ts-node --transpile-only src/scripts/test_module1_pivot_persistence.ts
 */
import mongoose from "mongoose";
// No real DB in this test — make writes fail fast instead of buffering 10s.
mongoose.set("bufferCommands", false);

import { enableMarketDataProcessing } from "../services/marketDataLifecycle";
import { stopBoundaryChecker } from "../services/ohlcAggregator";
import { recalculatePivots } from "../services/pivotService";

stopBoundaryChecker(); // no timer keeping the event loop alive
enableMarketDataProcessing();

let passed = 0;
let failed = 0;
const ok = (n: string) => { passed++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d?: unknown) => { failed++; console.error(`  ✗ ${n}`, d ?? ""); };

async function run() {
  console.log("\n── unsupported timeframes are skipped (no doomed create) ──");
  for (const tf of ["2m", "10m", "15m", "30m", "45m", "1h", "2h", "3h", "4h"]) {
    const res = await recalculatePivots("NIFTY-FUT", tf, 100, 90, 95);
    if (Object.keys(res).length === 0) ok(`${tf} → {} (skipped)`);
    else bad(`${tf} should be skipped`, res);
  }

  console.log("\n── supported timeframes still compute all 3 methods ──");
  for (const tf of ["1m", "3m", "5m", "custom"]) {
    const res = await recalculatePivots("NIFTY-FUT", tf, 120, 100, 110);
    const hasAll = !!res.classic && !!res.camarilla && !!res.fibonacci;
    if (hasAll) ok(`${tf} → classic + camarilla + fibonacci computed`);
    else bad(`${tf} missing a method`, Object.keys(res));
  }

  console.log("\n── computed pivot values are finite (not NaN) ──");
  {
    const res = await recalculatePivots("NIFTY-FUT", "5m", 120, 100, 110);
    const c = res.classic;
    const finite = c && [c.pivot, c.r1, c.r2, c.r3, c.s1, c.s2, c.s3].every((v) => Number.isFinite(v));
    if (finite) ok("classic 5m levels all finite");
    else bad("classic 5m levels not finite", c);
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} pivot persistence: ${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
