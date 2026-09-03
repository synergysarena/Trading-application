import { Schema } from "mongoose";

export const Module2SessionSchema = new Schema(
  {
    user_id: {
      type: String,
      required: true,
      index: true,
    },
    session_type: {
      type: String,
      enum: ["CE", "PE", "mixed"],
      required: true,
    },
    index_symbol: {
      type: String,
      required: true,
    },
    expiry_date: {
      type: String,
      required: true,
    },
    selected_strikes_json: {
      type: [String],
      default: [],
    },
    day_open_prices_json: {
      type: Object, // Map of strike -> baseline price
      default: {},
    },
    futures_oi_json: {
      type: Object,
      default: {},
    },
    status: {
      type: String,
      enum: ["ACTIVE", "STOPPED"],
      default: "ACTIVE",
      index: true,
    },
    started_at: {
      type: Date,
      default: Date.now,
    },
    stopped_at: {
      type: Date,
      default: null,
    },
    strike_start_boundaries: {
      type: Object, // Map of strike -> ISO timestamp / Date string
      default: {},
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);
