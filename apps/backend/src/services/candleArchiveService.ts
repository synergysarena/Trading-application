import { marketDataEvents } from "./marketDataEvents";
import { MinuteCandle } from "./minuteAggregationService";
import { Module2CandleArchive } from "../models/Module2CandleArchive";

/**
 * MongoDB Historical Storage (Phase 11).
 *
 * Subscribes to CANDLE_COMPLETED directly and independently of the Redis
 * history layer (candleHistoryService.ts, Phase 10) — the two never talk to
 * each other, and this service never reads from Redis to populate MongoDB.
 * MongoDB is permanent storage; Redis remains recent-history-only.
 *
 * The listener never awaits the write — it fires archiveCandle() and returns
 * immediately, so a slow or failing MongoDB can never block the event bus
 * that MinuteAggregationService (and every other CANDLE_COMPLETED consumer)
 * depends on.
 */

const TIMEFRAME = "1m";

export interface CandleArchiveStats {
  totalArchived: number;
  totalArchiveFailures: number;
  lastArchivedAt: string | null;
  lastError: string | null;
  totalDocuments: number | null; // null when MongoDB is unreachable, not zero
}

let totalArchived = 0;
let totalArchiveFailures = 0;
let lastArchivedAt: Date | null = null;
let lastError: string | null = null;

/**
 * Persists one COMPLETED candle via an idempotent upsert keyed on
 * (instrumentId, timeframe, minuteStart) — a duplicate CANDLE_COMPLETED for
 * the same minute overwrites rather than doubling up. Never throws upward;
 * a MongoDB failure is caught, logged, and counted.
 */
export const archiveCandle = async (candle: MinuteCandle): Promise<boolean> => {
  try {
    await Module2CandleArchive.updateOne(
      {
        instrumentId: candle.exchangeInstrumentID,
        timeframe: TIMEFRAME,
        minuteStart: new Date(candle.minuteStartTime),
      },
      {
        $setOnInsert: { createdAt: new Date() },
        $set: {
          exchangeSegment: candle.exchangeSegment,
          tradingSymbol: candle.tradingSymbol,
          minuteEnd: new Date(candle.minuteEndTime),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          openInterest: candle.openInterest,
          tickCount: candle.tickCount,
          completedAt: new Date(),
        },
      },
      { upsert: true }
    );

    totalArchived += 1;
    lastArchivedAt = new Date();
    lastError = null;
    return true;
  } catch (err: any) {
    lastError = err?.message || String(err);
    totalArchiveFailures += 1;
    console.error(`[CandleArchive] Failed to archive candle for ${candle.exchangeInstrumentID}:`, lastError);
    return false;
  }
};

export const getArchivedCandles = async (instrumentId: string, limit = 50) => {
  try {
    return await Module2CandleArchive.find({ instrumentId })
      .sort({ minuteStart: -1 })
      .limit(Math.max(1, limit))
      .lean();
  } catch (err: any) {
    console.error(`[CandleArchive] getArchivedCandles failed for ${instrumentId}:`, err?.message || err);
    return [];
  }
};

export const getLatestArchivedCandle = async (instrumentId: string) => {
  try {
    return await Module2CandleArchive.findOne({ instrumentId }).sort({ minuteStart: -1 }).lean();
  } catch (err: any) {
    console.error(`[CandleArchive] getLatestArchivedCandle failed for ${instrumentId}:`, err?.message || err);
    return null;
  }
};

export const getArchivedCandleRange = async (instrumentId: string, from: Date, to: Date) => {
  try {
    return await Module2CandleArchive.find({
      instrumentId,
      minuteStart: { $gte: from, $lte: to },
    })
      .sort({ minuteStart: 1 })
      .lean();
  } catch (err: any) {
    console.error(`[CandleArchive] getArchivedCandleRange failed for ${instrumentId}:`, err?.message || err);
    return [];
  }
};

export const deleteArchivedHistory = async (instrumentId: string): Promise<number> => {
  try {
    const result = await Module2CandleArchive.deleteMany({ instrumentId });
    return result.deletedCount || 0;
  } catch (err: any) {
    console.error(`[CandleArchive] deleteArchivedHistory failed for ${instrumentId}:`, err?.message || err);
    return 0;
  }
};

export const getArchiveStats = async (): Promise<CandleArchiveStats> => {
  let totalDocuments: number | null = null;
  try {
    totalDocuments = await Module2CandleArchive.estimatedDocumentCount();
  } catch (err: any) {
    console.error("[CandleArchive] estimatedDocumentCount failed:", err?.message || err);
  }

  return {
    totalArchived,
    totalArchiveFailures,
    lastArchivedAt: lastArchivedAt ? lastArchivedAt.toISOString() : null,
    lastError,
    totalDocuments,
  };
};

let initialized = false;

/** Called once at server startup. Idempotent — a second call is a no-op. */
export const initCandleArchive = (): void => {
  if (initialized) return;
  initialized = true;

  // Sync schema indexes (ensures the 48-hour TTL index is created/updated in MongoDB)
  Module2CandleArchive.syncIndexes().catch((err: any) => {
    console.error("[CandleArchive] Failed to sync indexes:", err?.message || err);
  });

  marketDataEvents.on("CANDLE_COMPLETED", (candle: MinuteCandle) => {
    // Fire-and-forget: never await here, so a slow/down MongoDB can never
    // block the event bus other CANDLE_COMPLETED consumers rely on.
    archiveCandle(candle).catch((err: any) => {
      console.error("[CandleArchive] Unexpected archive error:", err?.message || err);
    });
  });

  console.log("[CandleArchive] Initialized — persisting CANDLE_COMPLETED events to MongoDB with 48h TTL retention.");
};

