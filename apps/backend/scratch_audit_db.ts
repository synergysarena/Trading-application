import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { FuturesOHLC } from "./src/models/FuturesOHLC";
import { Module1CandleArchive } from "./src/models/Module1CandleArchive";

async function runDbAudit() {
  console.log("=================================================================");
  console.log("       MODULE 1 — READ-ONLY MONGODB MARKET DATA AUDIT           ");
  console.log("=================================================================\n");

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGODB_URI found in .env");
    return;
  }

  console.log("Attempting MongoDB connection with URI:", uri.replace(/:\/\/([^:@]+)(:[^@]+)?@/, "://***:***@"));
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log("Connected to MongoDB successfully.\n");
  } catch (connErr: any) {
    console.error("MongoDB connection failed:", connErr?.message || connErr);
    return;
  }

  // 1. Overall counts in FuturesOHLC & Module1CandleArchive
  const futuresCount = await FuturesOHLC.countDocuments();
  const archiveCount = await Module1CandleArchive.countDocuments();
  console.log(`FuturesOHLC total documents: ${futuresCount}`);
  console.log(`Module1CandleArchive total documents: ${archiveCount}\n`);

  // 2. Distinct symbols, timeframes, and dates
  const distinctSymbols = await FuturesOHLC.distinct("symbol");
  const distinctTfs = await FuturesOHLC.distinct("timeframe");
  console.log("FuturesOHLC Distinct Symbols:", distinctSymbols);
  console.log("FuturesOHLC Distinct Timeframes:", distinctTfs);

  // 3. Inspect symbols and dates
  const sampleDocs = await FuturesOHLC.find().sort({ bar_time: -1 }).limit(10);
  console.log("\nRecent 10 records in FuturesOHLC:");
  sampleDocs.forEach(d => {
    const istTime = new Date(d.bar_time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    console.log(`  symbol=${d.symbol} tf=${d.timeframe} bar_time=${d.bar_time.toISOString()} (IST: ${istTime}) O=${d.bar_open} H=${d.bar_high} L=${d.bar_low} C=${d.bar_close} vol=${d.volume}`);
  });

  // 4. Detailed timeline analysis for NIFTY-FUT (1m) and NIFTY-SPOT (1m)
  for (const sym of ["NIFTY-FUT", "NIFTY-SPOT"]) {
    console.log(`\n=================================================================`);
    console.log(`   TIMELINE ANALYSIS FOR: ${sym} (timeframe: 1m)`);
    console.log(`=================================================================`);

    const bars = await FuturesOHLC.find({ symbol: sym, timeframe: "1m" }).sort({ bar_time: 1 });
    console.log(`Total 1m bars found: ${bars.length}`);

    if (bars.length === 0) {
      console.log("No 1m bars in FuturesOHLC. Checking Module1CandleArchive...");
      const archBars = await Module1CandleArchive.find({ symbol: sym, timeframe: "1m" }).sort({ bar_time: 1 });
      console.log(`Total 1m archive bars found: ${archBars.length}`);
      continue;
    }

    // Group by IST trading date
    const dateGroups = new Map<string, typeof bars>();
    for (const b of bars) {
      const istDate = new Date(b.bar_time).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
      if (!dateGroups.has(istDate)) dateGroups.set(istDate, []);
      dateGroups.get(istDate)!.push(b);
    }

    for (const [dateStr, dayBars] of dateGroups.entries()) {
      console.log(`\n--- Date: ${dateStr} (Total bars: ${dayBars.length}) ---`);

      // Check duplicates
      const seenTimes = new Map<number, number>();
      const duplicates: number[] = [];
      dayBars.forEach(b => {
        const ms = new Date(b.bar_time).getTime();
        const cnt = (seenTimes.get(ms) || 0) + 1;
        seenTimes.set(ms, cnt);
        if (cnt === 2) duplicates.push(ms);
      });
      console.log(`Duplicate bar_time count: ${duplicates.length}`);

      // Check out of order
      let outOfOrderCount = 0;
      for (let i = 1; i < dayBars.length; i++) {
        if (new Date(dayBars[i].bar_time).getTime() <= new Date(dayBars[i - 1].bar_time).getTime()) {
          outOfOrderCount++;
        }
      }
      console.log(`Out-of-order bars count: ${outOfOrderCount}`);

      // Timeline gaps analysis (09:15 to 15:30 IST)
      // 09:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC (375 minutes)
      const firstBar = dayBars[0];
      const lastBar = dayBars[dayBars.length - 1];
      const firstIst = new Date(firstBar.bar_time).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
      const lastIst = new Date(lastBar.bar_time).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
      console.log(`First bar: ${firstIst} | Last bar: ${lastIst}`);

      // Gaps > 1 minute between consecutive recorded bars
      const gaps: { from: string; to: string; missingMinutes: number; fromMs: number; toMs: number }[] = [];
      for (let i = 1; i < dayBars.length; i++) {
        const prevMs = new Date(dayBars[i - 1].bar_time).getTime();
        const currMs = new Date(dayBars[i].bar_time).getTime();
        const diffMinutes = Math.round((currMs - prevMs) / 60000);
        if (diffMinutes > 1) {
          const fromStr = new Date(prevMs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
          const toStr = new Date(currMs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
          gaps.push({
            from: fromStr,
            to: toStr,
            missingMinutes: diffMinutes - 1,
            fromMs: prevMs,
            toMs: currMs,
          });
        }
      }

      console.log(`Total gap events (>1m gap): ${gaps.length}`);
      if (gaps.length > 0) {
        console.log("Detailed gaps found:");
        gaps.forEach((g, idx) => {
          console.log(`  [Gap #${idx + 1}] Between ${g.from} and ${g.to} -> Missing ${g.missingMinutes} minute(s)`);
        });
      }
    }
  }

  await mongoose.disconnect();
  console.log("\nDatabase audit complete. Disconnected.");
}

runDbAudit().catch(err => {
  console.error("Audit error:", err);
  process.exit(1);
});
