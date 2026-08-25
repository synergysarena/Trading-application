import { Module1CandleArchive } from "../models/Module1CandleArchive";
import { FuturesOHLC } from "../models/FuturesOHLC";
import { Candle } from "@stock/shared";

/**
 * Returns YYYY-MM-DD in IST timezone for a given timestamp/Date.
 */
export const getIstTradingDateStr = (ts: number | Date = Date.now()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

/**
 * Asynchronously archives finalized Module 1 candles into Module1CandleArchive.
 * Fire-and-forget, non-blocking for live tick processing.
 */
export const archiveModule1Candles = async (candles: Candle[]): Promise<void> => {
  if (!candles || candles.length === 0) return;

  const ops = candles.map((c) => {
    const barTimeDate = new Date(c.openTime);
    const tradingDate = getIstTradingDateStr(barTimeDate);

    return {
      updateOne: {
        filter: {
          tradingDate,
          symbol: c.symbol,
          timeframe: c.timeframe,
          bar_time: barTimeDate,
        },
        update: {
          $set: {
            bar_open: c.open,
            bar_high: c.high,
            bar_low: c.low,
            bar_close: c.close,
            volume: c.volume ?? 0,
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    };
  });

  try {
    await Module1CandleArchive.bulkWrite(ops, { ordered: false });
  } catch (error: any) {
    // Duplicate key exceptions on concurrent upsert race can be safely swallowed or logged
    if (error?.code !== 11000 && !error?.writeErrors?.every((w: any) => w.code === 11000)) {
      console.warn("[Module1Archive] Bulk archive write warning:", error?.message || error);
    }
  }
};

export interface Module1SessionCandle {
  symbol: string;
  timeframe: string;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_time: string; // ISO string
  volume: number;
}

/**
 * Retrieves all stored Module 1 candles for a specific trading date and timeframe.
 * Queries Module1CandleArchive first; if empty (e.g. active current day session),
 * queries live FuturesOHLC collection using the IST date boundary.
 */
export const getSessionCandlesForDate = async (
  dateStr: string,
  timeframe: string = "5m"
): Promise<{ candles: Module1SessionCandle[]; isLiveSession: boolean }> => {
  const todayIst = getIstTradingDateStr();
  const isToday = dateStr === todayIst;

  // 1. Try Module1CandleArchive first
  let archived = await Module1CandleArchive.find({ tradingDate: dateStr, timeframe })
    .sort({ bar_time: 1 })
    .lean();

  if (archived.length > 0) {
    return {
      isLiveSession: isToday,
      candles: archived.map((b) => ({
        symbol: b.symbol,
        timeframe: b.timeframe,
        bar_open: b.bar_open,
        bar_high: b.bar_high,
        bar_low: b.bar_low,
        bar_close: b.bar_close,
        bar_time: new Date(b.bar_time).toISOString(),
        volume: b.volume ?? 0,
      })),
    };
  }

  // 2. Fallback to live FuturesOHLC if date matches today's IST session or recent session
  // Calculate UTC start/end range for the requested IST date (09:15 IST to 15:30 IST)
  // 09:15 IST = 03:45 UTC; 15:30 IST = 10:00 UTC
  const startUtc = new Date(`${dateStr}T03:44:00.000Z`);
  const endUtc = new Date(`${dateStr}T10:01:00.000Z`);

  const liveBars = await FuturesOHLC.find({
    timeframe,
    bar_time: { $gte: startUtc, $lte: endUtc },
  })
    .sort({ bar_time: 1 })
    .lean();

  return {
    isLiveSession: isToday,
    candles: liveBars.map((b) => ({
      symbol: b.symbol,
      timeframe: b.timeframe,
      bar_open: b.bar_open,
      bar_high: b.bar_high,
      bar_low: b.bar_low,
      bar_close: b.bar_close,
      bar_time: new Date(b.bar_time).toISOString(),
      volume: b.volume ?? 0,
    })),
  };
};
