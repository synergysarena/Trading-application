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
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);
