/**
 * READ-ONLY Module 1 storage audit — proves whether tick → aggregator →
 * finalized candle → MongoDB actually reaches disk, and whether the daily
 * cleanup / TTL indexes are eating current-session data.
 *
 *   npx ts-node apps/backend/src/scripts/audit_module1_storage.ts
 *   (or from apps/backend:  npx ts-node src/scripts/audit_module1_storage.ts)
 *
 * Needs MONGODB_URI in the environment / .env. Performs NO writes.
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { FuturesOHLC } from "../models/FuturesOHLC";
import { Module1CandleArchive } from "../models/Module1CandleArchive";
import { PivotLevels } from "../models/PivotLevels";

const SESSION_OPEN_UTC_MINUTES = 3 * 60 + 45; // 09:15 IST

const ist = (d: Date | string | number) =>
  new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

const todayCalendarSessionOpen = (): Date => {
  const now = Date.now();
  const midnight = now - (now % 86_400_000);
  return new Date(midnight + SESSION_OPEN_UTC_MINUTES * 60_000);
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGODB_URI set — aborting.");
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log("  MODULE 1 STORAGE AUDIT (read-only)");
  console.log("=".repeat(70));
  console.log("URI:", uri.replace(/:\/\/([^:@]+)(:[^@]+)?@/, "://***:***@"));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`Connected. db=${mongoose.connection.name} state=${mongoose.connection.readyState}\n`);

  const cutoff = todayCalendarSessionOpen();
  console.log(`Cleanup cutoff (today's session open) = ${cutoff.toISOString()}  (IST ${ist(cutoff)})`);
  console.log(`Now                                    = ${new Date().toISOString()}  (IST ${ist(Date.now())})\n`);

  // ── FuturesOHLC ────────────────────────────────────────────────────────────
  const fTotal = await FuturesOHLC.estimatedDocumentCount();
  const fBefore = await FuturesOHLC.countDocuments({ bar_time: { $lt: cutoff } });
  const fAfter = await FuturesOHLC.countDocuments({ bar_time: { $gte: cutoff } });
  const fNewest = await FuturesOHLC.findOne().sort({ bar_time: -1 }).lean();
  const fTfs = await FuturesOHLC.distinct("timeframe");
  const fSyms = await FuturesOHLC.distinct("symbol");
  console.log("── FuturesOHLC ───────────────────────────────────────────────");
  console.log(`  total≈${fTotal}  | before cutoff (cleanup target): ${fBefore}  | current session (>= cutoff): ${fAfter}`);
  console.log(`  distinct symbols: ${fSyms.length}  | timeframes: ${JSON.stringify(fTfs)}`);
  if (fNewest) {
    console.log(`  newest bar_time: ${new Date(fNewest.bar_time).toISOString()} (IST ${ist(fNewest.bar_time)}) ` +
      `${fNewest.symbol}/${fNewest.timeframe} O=${fNewest.bar_open} C=${fNewest.bar_close} synthetic=${(fNewest as any).is_synthetic}`);
  } else {
    console.log("  newest bar_time: <none — collection empty>");
  }
  console.log(`  indexes: ${JSON.stringify(await FuturesOHLC.collection.indexes())}\n`);

  // ── Module1CandleArchive ──────────────────────────────────────────────────
  const aTotal = await Module1CandleArchive.estimatedDocumentCount();
  const aNewest = await Module1CandleArchive.findOne().sort({ bar_time: -1 }).lean();
  const aDates = await Module1CandleArchive.distinct("tradingDate");
  console.log("── Module1CandleArchive ──────────────────────────────────────");
  console.log(`  total≈${aTotal}  | tradingDates: ${JSON.stringify(aDates)}`);
  if (aNewest) {
    console.log(`  newest bar_time: ${new Date(aNewest.bar_time).toISOString()} (IST ${ist(aNewest.bar_time)}) ` +
      `${aNewest.symbol}/${aNewest.timeframe} createdAt=${new Date((aNewest as any).createdAt).toISOString()}`);
  } else {
    console.log("  newest: <none — collection empty>");
  }
  console.log(`  indexes: ${JSON.stringify(await Module1CandleArchive.collection.indexes())}\n`);

  // ── PivotLevels (collection: pivotlevels) ─────────────────────────────────
  const pTotal = await PivotLevels.estimatedDocumentCount();
  const pBefore = await PivotLevels.countDocuments({ computed_at: { $lt: cutoff } });
  const pAfter = await PivotLevels.countDocuments({ computed_at: { $gte: cutoff } });
  const pNewest = await PivotLevels.findOne().sort({ computed_at: -1 }).lean();
  const pTfs = await PivotLevels.distinct("timeframe");
  const pSyms = await PivotLevels.distinct("symbol");
  console.log("── PivotLevels (pivotlevels) ─────────────────────────────────");
  console.log(`  total≈${pTotal}  | before cutoff (cleanup target): ${pBefore}  | current session (>= cutoff): ${pAfter}`);
  console.log(`  distinct symbols: ${pSyms.length}  | timeframes ACTUALLY stored: ${JSON.stringify(pTfs)}`);
  if (pNewest) {
    console.log(`  newest computed_at: ${new Date((pNewest as any).computed_at).toISOString()} (IST ${ist((pNewest as any).computed_at)}) ` +
      `${pNewest.symbol}/${pNewest.timeframe}/${pNewest.method}`);
  } else {
    console.log("  newest: <none — collection empty>");
  }
  console.log(`  indexes: ${JSON.stringify(await PivotLevels.collection.indexes())}\n`);

  console.log("=".repeat(70));
  console.log("INTERPRETATION");
  console.log(`  • FuturesOHLC 'current session' = ${fAfter}. If ~0 during/after market hours`);
  console.log("    → persistence is failing upstream (not the cleanup — its filter is < cutoff).");
  console.log(`  • pivotlevels 'current session' = ${pAfter}, timeframes stored = ${JSON.stringify(pTfs)}.`);
  console.log("    → if only [] or missing 1m/3m/5m, pivot writes are failing (was silently swallowed).");
  console.log("=".repeat(70));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
