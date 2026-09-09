/**
 * READ-ONLY Module 1 per-minute presence diagnostic (Phase 1, Part 6).
 *
 * For a supplied trading date / time window and a CE + PE symbol, prints a
 * minute-by-minute grid showing whether a candle exists for FUT / SPOT / CE / PE
 * in BOTH persistence collections (FuturesOHLC and Module1CandleArchive), plus
 * the actual OHLC values. This is the tool that answers "where does the data
 * disappear" — MongoDB level vs everything downstream.
 *
 * Performs NO writes. Only .find() / .distinct() / .countDocuments().
 *
 *   npx ts-node --transpile-only src/scripts/diagnose_module1_minute_grid.ts \
 *     --date 2026-09-09 --tf 1m \
 *     --ce NIFTY15SEP26C25500 --pe NIFTY15SEP26P25500 \
 *     [--from 11:45 --to 12:05]   (IST HH:mm, optional — defaults to full session)
 *     [--fut NIFTY-FUT] [--spot NIFTY-SPOT]
 *
 * Needs MONGODB_URI in the environment / .env.
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { FuturesOHLC } from "../models/FuturesOHLC";
import { Module1CandleArchive } from "../models/Module1CandleArchive";

// ── arg parsing ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};

const dateStr = arg("date");
const tf = arg("tf", "1m")!;
const ceSym = arg("ce");
const peSym = arg("pe");
const futSym = arg("fut", "NIFTY-FUT")!;
const spotSym = arg("spot", "NIFTY-SPOT")!;
const fromHm = arg("from");
const toHm = arg("to");

if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
  console.error("Missing/invalid --date YYYY-MM-DD");
  process.exit(1);
}

const tfMs = (() => {
  const m = /^(\d+)([mh])$/.exec(tf);
  if (!m) { console.error(`Bad --tf ${tf}`); process.exit(1); }
  return Number(m![1]) * (m![2] === "h" ? 3_600_000 : 60_000);
})();

// IST HH:mm on `dateStr` → UTC epoch ms. IST = UTC+5:30.
const istToUtcMs = (hm: string): number => {
  const [h, mnt] = hm.split(":").map(Number);
  const base = Date.parse(`${dateStr}T00:00:00.000Z`);
  return base + (h * 60 + mnt) * 60_000 - 330 * 60_000;
};

// Full NSE session default: 09:15 IST → 15:30 IST
const startMs = fromHm ? istToUtcMs(fromHm) : istToUtcMs("09:15");
const endMs = toHm ? istToUtcMs(toHm) : istToUtcMs("15:30");

const istClock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });

const fmtOHLC = (b: any | undefined) =>
  b ? `${b.bar_open}/${b.bar_high}/${b.bar_low}/${b.bar_close}${b.is_synthetic ? " (syn)" : ""}` : "";

type BarDoc = {
  symbol: string; timeframe: string; bar_time: Date;
  bar_open: number; bar_high: number; bar_low: number; bar_close: number;
  volume?: number; is_synthetic?: boolean;
};

const indexByBucket = (docs: BarDoc[]): Map<number, BarDoc> => {
  const m = new Map<number, BarDoc>();
  for (const d of docs) {
    const t = new Date(d.bar_time).getTime();
    m.set(Math.floor(t / tfMs) * tfMs, d);
  }
  return m;
};

async function loadFutures(symbol: string): Promise<Map<number, BarDoc>> {
  const docs = await FuturesOHLC.find({
    symbol, timeframe: tf,
    bar_time: { $gte: new Date(startMs - tfMs), $lte: new Date(endMs + tfMs) },
  }).sort({ bar_time: 1 }).lean();
  return indexByBucket(docs as unknown as BarDoc[]);
}

async function loadArchive(symbol: string): Promise<Map<number, BarDoc>> {
  const docs = await Module1CandleArchive.find({
    tradingDate: dateStr, symbol, timeframe: tf,
    bar_time: { $gte: new Date(startMs - tfMs), $lte: new Date(endMs + tfMs) },
  }).sort({ bar_time: 1 }).lean();
  return indexByBucket(docs as unknown as BarDoc[]);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error("No MONGODB_URI set."); process.exit(1); }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`Connected. db=${mongoose.connection.name}`);
  console.log(
    `date=${dateStr} tf=${tf} window=${istClock(startMs)}..${istClock(endMs)} IST ` +
    `(${new Date(startMs).toISOString()} .. ${new Date(endMs).toISOString()})`
  );
  console.log(`FUT=${futSym} SPOT=${spotSym} CE=${ceSym ?? "(none)"} PE=${peSym ?? "(none)"}\n`);

  // ── collection-level context ────────────────────────────────────────────────
  for (const [label, model, filt] of [
    ["FuturesOHLC", FuturesOHLC, { timeframe: tf, bar_time: { $gte: new Date(startMs), $lte: new Date(endMs) } }],
    ["Module1CandleArchive", Module1CandleArchive, { tradingDate: dateStr, timeframe: tf }],
  ] as const) {
    const syms: string[] = await (model as any).distinct("symbol", filt);
    const opt = syms.filter((s) => /[CP]\d+$/.test(s));
    console.log(
      `[${label}] ${syms.length} distinct symbols for tf=${tf} in window ` +
      `(${opt.length} option, ${syms.length - opt.length} index/fut). ` +
      `FUT present=${syms.includes(futSym)} SPOT present=${syms.includes(spotSym)} ` +
      `CE present=${ceSym ? syms.includes(ceSym) : "-"} PE present=${peSym ? syms.includes(peSym) : "-"}`
    );
  }
  console.log();

  const live = {
    fut: await loadFutures(futSym),
    spot: await loadFutures(spotSym),
    ce: ceSym ? await loadFutures(ceSym) : new Map<number, BarDoc>(),
    pe: peSym ? await loadFutures(peSym) : new Map<number, BarDoc>(),
  };
  const arch = {
    fut: await loadArchive(futSym),
    spot: await loadArchive(spotSym),
    ce: ceSym ? await loadArchive(ceSym) : new Map<number, BarDoc>(),
    pe: peSym ? await loadArchive(peSym) : new Map<number, BarDoc>(),
  };

  const yn = (m: Map<number, BarDoc>, b: number) => (m.has(b) ? "YES" : "NO ");

  console.log("── FuturesOHLC (live collection) ─────────────────────────────────────────────");
  console.log("TIME   | FUT | SPOT| CE  | PE  | FUT O/H/L/C            | CE O/H/L/C        | PE O/H/L/C");
  let firstBucket = Math.floor(startMs / tfMs) * tfMs;
  let holesFut = 0, holesCe = 0, holesPe = 0, rows = 0;
  for (let b = firstBucket; b <= endMs; b += tfMs) {
    rows++;
    if (!live.fut.has(b)) holesFut++;
    if (ceSym && !live.ce.has(b)) holesCe++;
    if (peSym && !live.pe.has(b)) holesPe++;
    console.log(
      `${istClock(b)} | ${yn(live.fut, b)} | ${yn(live.spot, b)} | ${yn(live.ce, b)} | ${yn(live.pe, b)} | ` +
      `${fmtOHLC(live.fut.get(b)).padEnd(21)} | ${fmtOHLC(live.ce.get(b)).padEnd(16)} | ${fmtOHLC(live.pe.get(b))}`
    );
  }
  console.log(
    `\n  rows=${rows}  FUT holes=${holesFut}  ` +
    `CE holes=${ceSym ? holesCe : "-"}  PE holes=${peSym ? holesPe : "-"}`
  );

  console.log("\n── Module1CandleArchive ─────────────────────────────────────────────────────");
  console.log("TIME   | FUT | SPOT| CE  | PE");
  let aHolesFut = 0, aHolesCe = 0, aHolesPe = 0;
  for (let b = firstBucket; b <= endMs; b += tfMs) {
    if (!arch.fut.has(b)) aHolesFut++;
    if (ceSym && !arch.ce.has(b)) aHolesCe++;
    if (peSym && !arch.pe.has(b)) aHolesPe++;
    console.log(
      `${istClock(b)} | ${yn(arch.fut, b)} | ${yn(arch.spot, b)} | ${yn(arch.ce, b)} | ${yn(arch.pe, b)}`
    );
  }
  console.log(
    `\n  FUT holes=${aHolesFut}  CE holes=${ceSym ? aHolesCe : "-"}  PE holes=${peSym ? aHolesPe : "-"}`
  );

  console.log("\n── DIVERGENCE (FuturesOHLC vs Module1CandleArchive) ──────────────────────────");
  for (const [name, l, a] of [
    ["FUT", live.fut, arch.fut], ["SPOT", live.spot, arch.spot],
    ["CE", live.ce, arch.ce], ["PE", live.pe, arch.pe],
  ] as const) {
    if ((name === "CE" && !ceSym) || (name === "PE" && !peSym)) continue;
    const onlyLive: string[] = [], onlyArch: string[] = [];
    for (let b = firstBucket; b <= endMs; b += tfMs) {
      if (l.has(b) && !a.has(b)) onlyLive.push(istClock(b));
      if (!l.has(b) && a.has(b)) onlyArch.push(istClock(b));
    }
    console.log(
      `  ${name}: only in FuturesOHLC = [${onlyLive.join(", ") || "-"}]  |  ` +
      `only in Archive = [${onlyArch.join(", ") || "-"}]`
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("READING THE RESULT:");
  console.log("  • A minute NO in both collections  → data never persisted (backend: feed/");
  console.log("    tick/aggregation/persistence). Cross-check with MODULE1_OHLC_AUDIT logs.");
  console.log("  • CE/PE NO while FUT/SPOT YES        → option feed/subscription problem");
  console.log("    (strike not subscribed that minute) OR option genuinely did not trade.");
  console.log("  • YES here but the worksheet shows — → API or frontend problem; run the");
  console.log("    same window through GET /api/market/ohlc/<sym>/<tf> and compare.");
  console.log("=".repeat(78));

  await mongoose.disconnect();
}

main().catch((e) => { console.error("Diagnostic failed:", e); process.exit(1); });
