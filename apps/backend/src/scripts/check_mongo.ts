import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { Module2Session } from "../models/Module2Session";
import { Module2StrikeTick } from "../models/Module2StrikeTick";
import { Module2CandleArchive } from "../models/Module2CandleArchive";

async function detailedCheck() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/stock_dashboard";
  await mongoose.connect(uri);
  
  console.log("--- SESSIONS (last 5) ---");
  const sessions = await Module2Session.find().sort({ created_at: -1 }).limit(5).lean() as any[];
  for (const s of sessions) {
    console.log({
      id: s._id.toString(),
      user_id: s.user_id,
      index: s.index_symbol,
      expiry: s.expiry_date,
      status: s.status,
      created_at: s.created_at,
      started_at: s.started_at,
      stopped_at: s.stopped_at,
      strikesCount: s.selected_strikes_json?.length
    });
  }

  console.log("\n--- STRIKE TICKS (last 10) ---");
  const ticks = await Module2StrikeTick.find().sort({ minute_timestamp: -1 }).limit(10).lean() as any[];
  for (const t of ticks) {
    console.log({
      session_id: t.session_id.toString(),
      strike: t.strike,
      minute_timestamp: t.minute_timestamp,
      ltp: t.ltp_integer,
      is_day_high: t.is_day_high,
      is_day_low: t.is_day_low,
      pct_from_open: t.pct_from_open,
      oi: t.oi,
      oi_delta: t.oi_delta
    });
  }

  console.log("\n--- CANDLE ARCHIVES (last 10) ---");
  const candles = await Module2CandleArchive.find().sort({ minuteStart: -1 }).limit(10).lean() as any[];
  for (const c of candles) {
    console.log({
      instrumentId: c.instrumentId,
      tradingSymbol: c.tradingSymbol,
      minuteStart: c.minuteStart,
      minuteEnd: c.minuteEnd,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      createdAt: c.createdAt,
      completedAt: c.completedAt
    });
  }

  console.log("\n--- CANDLE ARCHIVES (sorted by createdAt -1) ---");
  const candlesByCreated = await Module2CandleArchive.find().sort({ createdAt: -1 }).limit(5).lean() as any[];
  for (const c of candlesByCreated) {
    console.log({
      instrumentId: c.instrumentId,
      tradingSymbol: c.tradingSymbol,
      minuteStart: c.minuteStart,
      createdAt: c.createdAt,
      completedAt: c.completedAt
    });
  }

  // Check TTL indexes on collections
  console.log("\n--- INDEXES ---");
  console.log("module2striketicks indexes:", await Module2StrikeTick.collection.indexes());
  console.log("module2candlearchives indexes:", await Module2CandleArchive.collection.indexes());
  console.log("module2sessions indexes:", await Module2Session.collection.indexes());

  await mongoose.disconnect();
}

detailedCheck().catch(console.error);
