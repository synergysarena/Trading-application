import { Schema } from "mongoose";

/**
 * Temporary archive storage for completed Module 1 OHLC candles.
 * Retains completed session data for 24 hours (86,400 seconds) so the user
 * can download full-session market data after market close.
 */
export const Module1CandleArchiveSchema = new Schema({
  tradingDate: {
    type: String,
    required: true,
    index: true,
  },
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
  bar_time: {
    type: Date,
    required: true,
  },
  volume: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Enforce single document per (tradingDate, timeframe, symbol, bar_time)
Module1CandleArchiveSchema.index(
  { tradingDate: 1, timeframe: 1, symbol: 1, bar_time: 1 },
  { unique: true }
);

// TTL index to purge temporary archive candles after 24 hours (86,400 seconds)
Module1CandleArchiveSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

