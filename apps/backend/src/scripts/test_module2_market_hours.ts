/**
 * Module 2 market-hours gate — controls when the Strike Tracker engine may
 * still produce per-minute rows (so the timeline freezes at 15:30 IST and no
 * synthetic post-close values are generated).
 *
 *   npx ts-node --transpile-only apps/backend/src/scripts/test_module2_market_hours.ts
 */
import assert from "assert";
import { isModule2MarketOpen, isModule2TrackingMinuteAllowed } from "../services/module2MarketHours";

let passed = 0;
const ok = (n: string) => { passed++; console.log(`  ✓ ${n}`); };

/** A Date whose Asia/Kolkata wall-clock is the given weekday/HH:MM.
 *  IST = UTC+5:30 with no DST, so we can build it directly in UTC. */
const istDate = (isoDateUtcMidnight: string, istHour: number, istMin: number): Date => {
  const base = new Date(`${isoDateUtcMidnight}T00:00:00.000Z`).getTime();
  return new Date(base + ((istHour - 5) * 60 + (istMin - 30)) * 60_000);
};

async function run() {
  // 2026-09-09 is a Wednesday; 2026-09-12 is a Saturday; 2026-09-13 Sunday.
  console.log("\n── weekday market window (IST 09:15 – 15:30) ──");
  {
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-09", 9, 14)), false, "09:14 → closed");
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-09", 9, 15)), true,  "09:15 → open");
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-09", 12, 0)), true,  "12:00 → open");
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-09", 15, 29)), true, "15:29 → open");
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-09", 15, 30)), false, "15:30 → closed (exclusive, matches /api/market/status)");
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-09", 15, 31)), false, "15:31 → closed");
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-09", 20, 0)), false, "20:00 → closed");
    ok("isModule2MarketOpen: open only within IST 09:15–15:30 (15:30 exclusive)");
  }

  console.log("\n── tracking-minute gate: allows the 15:30 closing snapshot, blocks 15:31+ ──");
  {
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-09", 9, 14)), false, "09:14 → blocked");
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-09", 9, 15)), true,  "09:15 → allowed");
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-09", 15, 29)), true, "15:29 → allowed");
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-09", 15, 30)), true, "15:30 → ALLOWED (closing row captured)");
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-09", 15, 31)), false, "15:31 → blocked (freeze)");
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-09", 16, 0)), false, "16:00 → blocked");
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-09", 8, 0)), false, "08:00 → blocked");
    ok("isModule2TrackingMinuteAllowed: 09:15 ≤ t ≤ 15:30 only");
  }

  console.log("\n── weekends are always closed ──");
  {
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-12", 11, 0)), false, "Saturday 11:00 → closed");
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-13", 11, 0)), false, "Sunday 11:00 → closed");
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-12", 11, 0)), false, "Saturday 11:00 → blocked");
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-13", 11, 0)), false, "Sunday 11:00 → blocked");
    ok("weekend → market closed / tracking blocked");
  }

  console.log("\n── next trading day resumes normally ──");
  {
    // Thursday 2026-09-10 morning
    assert.strictEqual(isModule2TrackingMinuteAllowed(istDate("2026-09-10", 9, 20)), true, "next day 09:20 → allowed again");
    assert.strictEqual(isModule2MarketOpen(istDate("2026-09-10", 10, 0)), true, "next day 10:00 → open again");
    ok("the gate re-opens on the next trading day (no permanent freeze)");
  }

  console.log(`\n✅ All ${passed} Module 2 market-hours assertions passed.\n`);
}

run().then(() => process.exit(0)).catch((e) => { console.error("\n❌ FAILURE:\n", e); process.exit(1); });
