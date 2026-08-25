import { Schema } from "mongoose";

/**
 * Permanent historical storage for completed 1-minute candles (Phase 11).
 * Independent of the Redis history layer (Phase 10) — this schema is never
 * populated from Redis, only from CANDLE_COMPLETED directly.
 */
export const Module2CandleArchiveSchema = new Schema({
  exchangeSegment: { type: Number, default: null },
  instrumentId: { type: String, required: true },
  tradingSymbol: { type: String, default: null },
  timeframe: { type: String, required: true, default: "1m" },
  minuteStart: { type: Date, required: true },
  minuteEnd: { type: Date, required: true },
  open: { type: Number, required: true },
  high: { type: Number, required: true },
  low: { type: Number, required: true },
  close: { type: Number, required: true },
  volume: { type: Number, default: null },
  openInterest: { type: Number, default: null },
  tickCount: { type: Number, required: true },
  completedAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

// Step 3: single-field indexes for historical queries.
Module2CandleArchiveSchema.index({ instrumentId: 1 });
Module2CandleArchiveSchema.index({ minuteStart: 1 });

// Step 3: compound index for the most common historical query shape
// (an instrument's candles, ordered by time, optionally scoped by segment).
Module2CandleArchiveSchema.index({ exchangeSegment: 1, instrumentId: 1, minuteStart: 1 });

// Bonus (beyond Step 3's literal list): a uniqueness guard on
// (instrumentId, timeframe, minuteStart) so a duplicate CANDLE_COMPLETED
// emission — or an archiveCandle() retry after a transient failure — can
// never create two rows for the same instrument-minute. Mirrors the same
// duplicate-prevention pattern already established for Module 1's
// FuturesOHLC model (unique on symbol+timeframe+bar_time).
Module2CandleArchiveSchema.index(
  { instrumentId: 1, timeframe: 1, minuteStart: 1 },
  { unique: true }
);

// Step 4: TTL index to automatically purge archived 1-minute candles after 48 hours (172,800 seconds)
Module2CandleArchiveSchema.index({ createdAt: 1 }, { expireAfterSeconds: 172800 });

