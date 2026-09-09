/**
 * Regression: Module 1 subscribes to (and therefore stores) the COMPLETE
 * nearest-expiry NIFTY option chain — no ATM ±1000/±5000 band, no strike cap,
 * no dependence on the frontend-selected strike.
 *
 *   npx ts-node --transpile-only src/scripts/test_module1_option_universe.ts
 */
import mongoose from "mongoose";
mongoose.set("bufferCommands", false);

import {
  selectOptionTokens,
  buildActiveTokens,
  getOptionStrikeRadius,
  type MasterRow,
} from "../services/instrumentTokenService";
import { enableMarketDataProcessing } from "../services/marketDataLifecycle";
import {
  aggregateOHLC,
  getActiveCandle,
  getCachedOHLCBars,
  stopBoundaryChecker,
  clearActiveCandles,
} from "../services/ohlcAggregator";
import type { Tick } from "@stock/shared";

stopBoundaryChecker();
enableMarketDataProcessing();

let passed = 0;
let failed = 0;
const ok = (n: string) => { passed++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d?: unknown) => { failed++; console.error(`  ✗ ${n}`, d ?? ""); };

// ── Synthetic instrument master ────────────────────────────────────────────────
const NEAR = new Date("2026-09-15T00:00:00.000Z");
const FAR = new Date("2026-09-22T00:00:00.000Z");

const mkOpt = (strike: number, ot: "CE" | "PE", expiry: Date, sym = "NIFTY"): MasterRow => ({
  exchange: "NFO",
  token: `${sym}${strike}${ot}${expiry.getUTCDate()}`,
  symbol: sym,
  tradingSymbol: `${sym}${strike}${ot}`,
  expiry,
  strike,
  optionType: ot,
  instrumentType: "OPTIDX",
});

const rows: MasterRow[] = [];
// Nearest expiry: full chain 15000..35000 step 50  → 401 CE + 401 PE
const NEAR_STRIKES: number[] = [];
for (let s = 15000; s <= 35000; s += 50) NEAR_STRIKES.push(s);
for (const s of NEAR_STRIKES) { rows.push(mkOpt(s, "CE", NEAR)); rows.push(mkOpt(s, "PE", NEAR)); }
// Farther expiry — must be excluded (expiry scoping stays intact)
for (let s = 24000; s <= 26000; s += 50) { rows.push(mkOpt(s, "CE", FAR)); rows.push(mkOpt(s, "PE", FAR)); }
// Non-NIFTY — must be excluded
for (let s = 50000; s <= 52000; s += 100) { rows.push(mkOpt(s, "CE", NEAR, "BANKNIFTY")); }
// NIFTY future for buildActiveTokens
rows.push({
  exchange: "NFO", token: "NIFTYFUT", symbol: "NIFTY", tradingSymbol: "NIFTY26SEPFUT",
  expiry: new Date("2026-09-29T00:00:00.000Z"), strike: 0, optionType: "XX", instrumentType: "FUTIDX",
});

const CE_TOTAL = NEAR_STRIKES.length; // 401
const PE_TOTAL = NEAR_STRIKES.length; // 401

function run() {
  console.log("\n── TEST 1 & 8: full nearest-expiry universe selected, no strike cap ──");
  {
    const { ceTokens, peTokens } = selectOptionTokens(rows, NEAR, 25000 /* atm */);
    if (ceTokens.length === CE_TOTAL && peTokens.length === PE_TOTAL) ok(`all ${CE_TOTAL} CE + ${PE_TOTAL} PE selected`);
    else bad("universe not fully selected", { ce: ceTokens.length, pe: peTokens.length, want: CE_TOTAL });
    if (ceTokens.length > 20 && peTokens.length > 20) ok("no 10/20-strike cap");
    else bad("looks capped", ceTokens.length);
  }

  console.log("\n── TEST 2: no ATM ±1000/±5000 band (far-OTM strikes present) ──");
  {
    const { ceTokens, peTokens } = selectOptionTokens(rows, NEAR, 25000);
    const hasLow = ceTokens.some(t => t.endsWith("C15000")) && peTokens.some(t => t.endsWith("P15000"));
    const hasHigh = ceTokens.some(t => t.endsWith("C35000")) && peTokens.some(t => t.endsWith("P35000"));
    if (hasLow && hasHigh) ok("strikes 10000 pts from ATM are included (15000 & 35000)");
    else bad("far strikes missing", { hasLow, hasHigh });
  }

  console.log("\n── TEST 3: buildActiveTokens subscribes the whole chain regardless of atmIsReliable ──");
  {
    const a = buildActiveTokens(rows, 25000, true);
    const b = buildActiveTokens(rows, 25000, false);
    if (a.ceTokens.length === CE_TOTAL && a.peTokens.length === PE_TOTAL) ok(`atmReliable=true → ${a.ceTokens.length} CE + ${a.peTokens.length} PE`);
    else bad("reliable path shrank the chain", a.ceTokens.length);
    if (b.ceTokens.length === CE_TOTAL && b.peTokens.length === PE_TOTAL) ok("atmReliable=false → same full chain (no ±5000 fallback band)");
    else bad("unreliable path shrank the chain", b.ceTokens.length);
    if (a.futToken && a.futToken.includes("NIFTY-FUT")) ok("NIFTY future still resolved");
    else bad("future token missing", a.futToken);
  }

  console.log("\n── expiry scoping + non-NIFTY exclusion still hold ──");
  {
    const { ceTokens } = selectOptionTokens(rows, NEAR, 25000);
    const anyFar = ceTokens.some(t => /C\d+$/.test(t) && t.includes("22SEP")); // FAR formatted 22SEP26
    const anyBankStrike = ceTokens.some(t => t.endsWith("C50000") || t.endsWith("C52000"));
    if (!anyFar) ok("farther-expiry contracts excluded");
    else bad("leaked a farther expiry");
    if (!anyBankStrike) ok("non-NIFTY (BANKNIFTY) contracts excluded");
    else bad("leaked BANKNIFTY");
  }

  console.log("\n── ops-only safety valve MODULE1_OPTION_STRIKE_RADIUS (default = no limit) ──");
  {
    if (getOptionStrikeRadius() === Infinity) ok("default radius = Infinity (full universe)");
    else bad("default radius is finite!", getOptionStrikeRadius());

    process.env.MODULE1_OPTION_STRIKE_RADIUS = "1000";
    const limited = selectOptionTokens(rows, NEAR, 25000, getOptionStrikeRadius());
    delete process.env.MODULE1_OPTION_STRIKE_RADIUS;
    // 25000 ± 1000 step 50 ⇒ 41 strikes
    if (limited.ceTokens.length === 41) ok("override to ±1000 works as an explicit ops action (41 strikes)");
    else bad("override math off", limited.ceTokens.length);
    if (getOptionStrikeRadius() === Infinity) ok("unsetting the override restores the full universe");
    else bad("override stuck");
  }

  console.log("\n── TEST 4 & 5: an UNSELECTED strike is still aggregated independently per symbol ──");
  {
    clearActiveCandles(); enableMarketDataProcessing(); stopBoundaryChecker();
    const min = Math.floor(Date.now() / 60000) * 60000;
    const t = (sym: string, ltp: number, offMs: number): Tick => ({
      symbol: sym, ltp, timestamp: new Date(min + offMs), volume: 5,
    });
    // C20500 = "not selected in any UI", C20550 = "selected" — the aggregator has no such concept
    return (async () => {
      await aggregateOHLC(t("NIFTY15SEP26C20500", 100, 1000), 1, "1m");
      await aggregateOHLC(t("NIFTY15SEP26C20500", 110, 2000), 1, "1m");
      await aggregateOHLC(t("NIFTY15SEP26C20550", 300, 1000), 1, "1m");
      await aggregateOHLC(t("NIFTY15SEP26C20550", 290, 2000), 1, "1m");
      await aggregateOHLC(t("NIFTY15SEP26P20550", 44, 1500), 1, "1m");

      const a = getActiveCandle("NIFTY15SEP26C20500", "1m");
      const b = getActiveCandle("NIFTY15SEP26C20550", "1m");
      const p = getActiveCandle("NIFTY15SEP26P20550", "1m");
      if (a && a.open === 100 && a.high === 110 && a.close === 110) ok("unselected C20500 aggregated correctly (O100 H110 C110)");
      else bad("C20500 wrong", a);
      if (b && b.open === 300 && b.low === 290 && b.close === 290) ok("selected C20550 aggregated independently (O300 L290 C290)");
      else bad("C20550 wrong", b);
      if (p && p.open === 44) ok("PE20550 aggregated independently");
      else bad("P20550 wrong", p);
      if (a && b && a !== b && a.close !== b.close) ok("strikes never merged / overwritten");
      else bad("strikes collided");

      console.log(`\n${failed === 0 ? "✅" : "❌"} option universe: ${passed} passed, ${failed} failed.`);
      process.exit(failed > 0 ? 1 : 0);
    })();
  }
}

Promise.resolve(run()).catch((e) => { console.error(e); process.exit(1); });
