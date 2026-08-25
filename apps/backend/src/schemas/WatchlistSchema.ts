import { Schema } from "mongoose";

export const WatchlistSchema = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    symbols_json: {
      type: [String],
      default: [],
    },
    column_prefs_json: {
      type: Object,
      default: {},
    },
  },
  {
    timestamps: { createdAt: false, updatedAt: "updated_at" },
  }
);
