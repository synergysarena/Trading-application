import { model } from "mongoose";
import { FuturesOHLCSchema } from "../schemas/FuturesOHLCSchema";

export const FuturesOHLC = model("FuturesOHLC", FuturesOHLCSchema);

/**
 * One-time startup migration for the unique candle index:
 * 1. Deletes any duplicate (symbol, timeframe, bar_time) documents left behind
 *    by the old non-unique index, keeping the most recently written one (it
 *    holds the final finalized bar values).
 * 2. Syncs schema indexes so the unique compound index is actually built and
 *    the old non-unique / conflicting indexes are dropped.
 * Must run after MongoDB connects and before live ticks start persisting.
 */
export const ensureUniqueCandleIndex = async (): Promise<void> => {
  const dupes: { ids: unknown[] }[] = await FuturesOHLC.aggregate([
    {
      $group: {
        _id: { symbol: "$symbol", timeframe: "$timeframe", bar_time: "$bar_time" },
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  for (const d of dupes) {
    // ObjectIds sort chronologically as hex strings — keep the newest.
    const stale = d.ids
      .map(String)
      .sort()
      .slice(0, -1);
    await FuturesOHLC.deleteMany({ _id: { $in: stale } });
  }
  if (dupes.length > 0) {
    console.log(`[OHLC] Removed duplicate candles for ${dupes.length} (symbol, timeframe, bar_time) key(s).`);
  }

  await FuturesOHLC.syncIndexes();
  console.log("[OHLC] Unique candle index (symbol, timeframe, bar_time) ensured.");
};
