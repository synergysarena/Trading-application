import { model } from "mongoose";
import { PivotLevelsSchema } from "../schemas/PivotLevelsSchema";

export const PivotLevels = model("PivotLevels", PivotLevelsSchema);

/**
 * Phase 2 one-time DB maintenance for the new unique pivot key.
 *
 * The live pivot path used to `create()` a fresh document every minute per
 * (symbol, timeframe, method) — ~97k docs/session for the 456-instrument
 * universe. It now UPSERTs on (symbol, timeframe, method), so:
 *   1. collapse the existing duplicates, keeping the most recently created row,
 *   2. sync schema indexes so the unique compound index actually builds.
 *
 * Phase 2.1: this is BACKGROUND maintenance — the caller (server.ts) must NOT
 * await it before `server.listen()`. It is:
 *   • idempotent — once the unique index exists it is a sub-second no-op (a
 *     duplicate cannot exist while the index is present), and it re-runs
 *     harmlessly if a prior run was interrupted;
 *   • bounded — the dedup is a single chunked bulkWrite of `deleteMany` ops
 *     (was one awaited `deleteMany` per dup group ⇒ thousands of sequential
 *     round trips on a 97k-doc collection ⇒ minutes of startup blocking);
 *   • defensive — never throws; on failure the collection just keeps its old
 *     (non-unique) shape until the next boot, and the single-writer upsert path
 *     still produces exactly one row per key in the meantime.
 */
export const ensurePivotIndexes = async (): Promise<void> => {
  const started = Date.now();
  try {
    // Fast path: if the unique index is already present, the collection is
    // already deduped (the index could not exist otherwise) and no new
    // duplicate can be created — nothing to do.
    const existing: any[] = await PivotLevels.collection.indexes();
    const hasUnique = existing.some(
      (ix) => ix?.unique && ix?.key?.symbol === 1 && ix?.key?.timeframe === 1 && ix?.key?.method === 1
    );
    if (hasUnique) {
      console.log("[Pivots] Unique pivot index already present — no maintenance needed.");
      return;
    }

    // 1. One aggregate to find each duplicated key + the _id to KEEP (newest).
    //    Uses $max:$_id (ObjectIds are time-ordered) instead of $push-ing every
    //    id, so the pipeline output is ~one small doc per dup key, not MBs.
    const dupKeys: { _id: { symbol: string; timeframe: string; method: string }; keep: unknown; count: number }[] =
      await PivotLevels.aggregate(
        [
          {
            $group: {
              _id: { symbol: "$symbol", timeframe: "$timeframe", method: "$method" },
              keep: { $max: "$_id" },
              count: { $sum: 1 },
            },
          },
          { $match: { count: { $gt: 1 } } },
        ],
        { allowDiskUse: true }
      );

    if (dupKeys.length > 0) {
      // 2. Delete every doc for those keys EXCEPT the kept one, via chunked
      //    bulkWrite — a handful of round trips instead of one per key.
      const ops = dupKeys.map((d) => ({
        deleteMany: {
          filter: {
            symbol: d._id.symbol,
            timeframe: d._id.timeframe,
            method: d._id.method,
            _id: { $ne: d.keep },
          },
        },
      }));
      let removed = 0;
      const CHUNK = 500;
      for (let i = 0; i < ops.length; i += CHUNK) {
        const res: any = await PivotLevels.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
        removed += res?.deletedCount || 0;
      }
      console.log(`[Pivots] Collapsed ${removed} duplicate pivot document(s) across ${dupKeys.length} key(s) in ${Date.now() - started}ms.`);
    }

    // 3. Build the unique index (and reconcile the rest of the schema indexes).
    await PivotLevels.syncIndexes();
    console.log(`[Pivots] Unique pivot index (symbol, timeframe, method) ensured (${Date.now() - started}ms).`);
  } catch (err: any) {
    console.error(
      `[Pivots] ensurePivotIndexes failed after ${Date.now() - started}ms ` +
      `(non-fatal, retried next boot; single-writer upsert path is unaffected):`,
      err?.message || err
    );
  }
};
