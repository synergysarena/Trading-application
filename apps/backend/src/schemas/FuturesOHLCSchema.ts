import { Schema } from "mongoose";

export const FuturesOHLCSchema = new Schema({
  symbol: {
    type: String,
    required: true,
    index: true,
  },
  timeframe: {
    type: String,
    required: true,
    index: true,
  },
  bar_open: {
    type: Number,
    required: true,
  },
  bar_high: {
    type: Number,
    required: true,
  },
  bar_low: {
    type: Number,
    required: true,
  },
  bar_close: {
    type: Number,
    required: true,
  },
  // NOTE: no path-level index here — bar_time is indexed by the TTL index
  // below (a plain bar_time_1 index would conflict with it) and by the unique
  // compound index.
  bar_time: {
    type: Date,
    required: true,
  },
  volume: {
    type: Number,
    default: 0,
  },
});

// One candle per (symbol, timeframe, bar_time) — enforced at the DB level so
// racing upserts can never insert duplicates. Also serves the latest-candles
// query for pivot calculation (replaces the old non-unique bar_time:-1 index).
FuturesOHLCSchema.index({ symbol: 1, timeframe: 1, bar_time: 1 }, { unique: true });

// TTL index: MongoDB auto-deletes candles older than 24 hours (86,400 seconds).
// Daily session cleanup is additionally managed at startup and daily rollover
// by module1DataCleanupService.ts.
FuturesOHLCSchema.index({ bar_time: 1 }, { expireAfterSeconds: 86400 });

