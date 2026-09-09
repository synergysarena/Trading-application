/**
 * READ-ONLY verification that Module 1 is storing OHLC for the full NIFTY option
 * chain — not just the frontend-selected strikes.
 *
 *   npx ts-node src/scripts/verify_module1_option_storage.ts
 *
 * Reports, for today's IST session, from FuturesOHLC and Module1CandleArchive:
 *   distinct option symbols, CE/PE counts, strike range, sample strikes across
 *   the range, per-strike candle counts, earliest/latest stored minute.
 * Performs NO writes.
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { FuturesOHLC } from "../models/FuturesOHLC";
import { Module1CandleArchive } from "../models/Module1CandleArchive";

const OPT_RE = /^NIFTY.*[CP](\d+)$/;
const ist = (d: Date | string | number) =>
  new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

const istTradingDateStr = (ts = Date.now()) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ts));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
};

const strikeOf = (sym: string): number | null => {
  const m = OPT_RE.exec(sym);
  return m ? Number(m[1]) : null;
};
const sideOf = (sym: string): "CE" | "PE" | null =>
  /C\d+$/.test(sym) ? "CE" : /P\d+$/.test(sym) ? "PE" : null;

const sample = <T,>(arr: T[], n: number): T[] => {
  if (arr.length <= n * 3) return arr;
  return [...arr.slice(0, n), ...arr.slice(Math.floor(arr.length / 2) - Math.floor(n / 2), Math.floor(arr.length / 2) + Math.ceil(n / 2)), ...arr.slice(-n)];
};

async function reportCollection(name: string, model: any, timeField: string, dateFilter: Record<string, unknown>) {
  console.log("=".repeat(70));
  console.log(`  ${name}`);
  console.log("=".repeat(70));

  const symbols: string[] = await model.distinct("symbol", dateFilter);
  const optSymbols = symbols.filter((s) => OPT_RE.test(s)).sort((a, b) => (strikeOf(a)! - strikeOf(b)!) || a.localeCompare(b));
  const ce = optSymbols.filter((s) => sideOf(s) === "CE");
  const pe = optSymbols.filter((s) => sideOf(s) === "PE");
  const strikes = [...new Set(optSymbols.map(strikeOf).filter((x): x is number => x != null))].sort((a, b) => a - b);

  console.log(`  distinct option symbols stored: ${optSymbols.length}  (CE ${ce.length} | PE ${pe.length})`);
  console.log(`  non-option symbols: ${symbols.filter((s) => !OPT_RE.test(s)).join(", ") || "(none)"}`);
  if (strikes.length) {
    console.log(`  strike range: ${strikes[0]} … ${strikes[strikes.length - 1]}  (${strikes.length} distinct strikes)`);
    console.log(`  sample strikes: ${sample(strikes, 5).join(", ")}`);
  }

  if (optSymbols.length === 0) {
    console.log("  ⚠  NO option OHLC stored for today — feed not started, or storage broken.");
    return;
  }

  const oldest = await model.findOne({ ...dateFilter, symbol: { $in: optSymbols } }).sort({ [timeField]: 1 }).lean();
  const newest = await model.findOne({ ...dateFilter, symbol: { $in: optSymbols } }).sort({ [timeField]: -1 }).lean();
  if (oldest) console.log(`  earliest option candle: ${ist(oldest[timeField])}  (${oldest.symbol})`);
  if (newest) console.log(`  latest   option candle: ${ist(newest[timeField])}  (${newest.symbol})`);

  const perStrike = await model.aggregate([
    { $match: { ...dateFilter, symbol: { $in: optSymbols } } },
    { $group: { _id: "$symbol", n: { $sum: 1 }, tfs: { $addToSet: "$timeframe" } } },
    { $sort: { n: -1 } },
  ]);
  console.log(`  candles per symbol — top 5:`);
  for (const r of perStrike.slice(0, 5)) console.log(`      ${r._id.padEnd(22)} ${String(r.n).padStart(5)} candles  tfs=${r.tfs.sort().join(",")}`);
  console.log(`  candles per symbol — bottom 5:`);
  for (const r of perStrike.slice(-5)) console.log(`      ${r._id.padEnd(22)} ${String(r.n).padStart(5)} candles  tfs=${r.tfs.sort().join(",")}`);

  // Coverage sanity: how many strikes have a 1m candle (proves broad, not ATM-only, storage)
  const oneMinStrikes = new Set(
    (await model.distinct("symbol", { ...dateFilter, timeframe: "1m", symbol: { $in: optSymbols } })).map(strikeOf).filter(Boolean)
  );
  console.log(`  strikes with ≥1 stored 1m candle: ${oneMinStrikes.size} / ${strikes.length}`);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error("No MONGODB_URI set."); process.exit(1); }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`Connected. db=${mongoose.connection.name}\n`);

  const dateStr = istTradingDateStr();
  // Today's IST session window in UTC: 09:15 IST = 03:44Z … 15:30 IST = 10:01Z
  const startUtc = new Date(`${dateStr}T03:44:00.000Z`);
  const endUtc = new Date(`${dateStr}T10:01:00.000Z`);
  console.log(`IST trading date: ${dateStr}  |  window ${startUtc.toISOString()} … ${endUtc.toISOString()}\n`);

  await reportCollection("FuturesOHLC (live)", FuturesOHLC, "bar_time", { bar_time: { $gte: startUtc, $lte: endUtc } });
  console.log();
  await reportCollection("Module1CandleArchive", Module1CandleArchive, "bar_time", { tradingDate: dateStr });

  console.log("\n" + "=".repeat(70));
  console.log("PASS CRITERIA: 'distinct option symbols stored' and 'strikes with ≥1");
  console.log("stored 1m candle' should reflect the WHOLE nearest-expiry chain");
  console.log("(hundreds), not ~40-80 around ATM, and must include strikes far from");
  console.log("spot that were never selected in the UI.");
  console.log("=".repeat(70));

  await mongoose.disconnect();
}

main().catch((e) => { console.error("Verify failed:", e); process.exit(1); });
