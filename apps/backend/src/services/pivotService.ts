import { FuturesOHLC } from "../models/FuturesOHLC";
import { PivotLevels as PivotLevelsModel } from "../models/PivotLevels";
import { setOnCandleFinalized } from "./ohlcAggregator";
import { readLive } from "./redisWriteBuffer";
import {
  calculateClassicPivot,
  calculateCamarillaPivot,
  calculateFibonacciPivot,
  getCallIndicator,
  getPutIndicator,
  getDivergence,
} from "../utils/pivotEngine";
import { isMarketDataProcessingEnabled } from "./marketDataLifecycle";
import { Candle, PivotLevels, Module1Indicators } from "@stock/shared";

// Local cache for the latest computed pivots: latestPivots[symbol][timeframe][method]
const latestPivots: Record<string, Record<string, Record<string, PivotLevels>>> = {};

// Callback to trigger WebSocket broadcasts when pivots recalculate
type PivotsUpdatedCallback = (pivots: Record<string, PivotLevels>) => Promise<void> | void;
let onPivotsUpdated: PivotsUpdatedCallback | null = null;

export const setOnPivotsUpdated = (callback: PivotsUpdatedCallback) => {
  onPivotsUpdated = callback;
};

/**
 * Initialize pivot service and register finalized candle listener
 */
export const initPivotService = () => {
  setOnCandleFinalized(async (candle: Candle) => {
    if (!isMarketDataProcessingEnabled()) return;
    console.log(`[PivotService] Finalized candle received for ${candle.symbol} (${candle.timeframe}). Recalculating pivots...`);
    await recalculatePivots(candle.symbol, candle.timeframe, candle.high, candle.low, candle.close);
  });
};

/**
 * Recalculates pivots using all 3 methods and saves to DB and cache
 */
export const recalculatePivots = async (
  symbol: string,
  timeframe: string,
  high: number,
  low: number,
  close: number
): Promise<Record<string, PivotLevels>> => {
  if (!isMarketDataProcessingEnabled()) return {};
  const date = new Date();
  const computedAt = date;

  // 1. Compute Classic Pivots
  const classic = calculateClassicPivot(high, low, close);
  // 2. Compute Camarilla Pivots
  const camarilla = calculateCamarillaPivot(high, low, close);
  // 3. Compute Fibonacci Pivots
  const fibonacci = calculateFibonacciPivot(high, low, close);

  const results: Record<string, PivotLevels> = {};

  const methods = [
    { name: "classic" as const, levels: classic },
    { name: "camarilla" as const, levels: camarilla },
    { name: "fibonacci" as const, levels: fibonacci },
  ];

  for (const m of methods) {
    const pivotDoc = {
      symbol,
      timeframe,
      method: m.name,
      pivot: "P" in m.levels ? (m.levels as any).P : close,
      r1: m.levels.R1,
      r2: m.levels.R2,
      r3: m.levels.R3,
      r4: "R4" in m.levels ? (m.levels as any).R4 : undefined,
      s1: m.levels.S1,
      s2: m.levels.S2,
      s3: m.levels.S3,
      s4: "S4" in m.levels ? (m.levels as any).S4 : undefined,
      computedAt,
    };

    // Save to Database
    try {
      await PivotLevelsModel.create({
        ...pivotDoc,
        date,
        computed_at: computedAt,
      });
    } catch (err) {
      // Suppress database write failure when offline
    }

    // Save to local cache
    if (!latestPivots[symbol]) latestPivots[symbol] = {};
    if (!latestPivots[symbol][timeframe]) latestPivots[symbol][timeframe] = {};
    latestPivots[symbol][timeframe][m.name] = pivotDoc;

    results[m.name] = pivotDoc;
  }

  // Notify WebSocket server
  if (onPivotsUpdated) {
    await onPivotsUpdated(results);
  }

  return results;
};

/**
 * Gets cached pivot levels or loads them from MongoDB if cache is empty
 */
export const getPivotLevels = async (
  symbol: string,
  timeframe: string,
  method: "classic" | "camarilla" | "fibonacci"
): Promise<PivotLevels | null> => {
  // Check local cache
  if (latestPivots[symbol]?.[timeframe]?.[method]) {
    return latestPivots[symbol][timeframe][method];
  }

  // Fetch from database
  let doc = null;
  try {
    doc = await PivotLevelsModel.findOne({ symbol, timeframe, method }).sort({ computed_at: -1 });
  } catch (err) {
    // Suppress warning when offline
  }

  if (doc) {
    const levels: PivotLevels = {
      symbol: doc.symbol,
      timeframe: doc.timeframe,
      method: doc.method as any,
      pivot: doc.pivot,
      r1: doc.r1,
      r2: doc.r2,
      r3: doc.r3,
      r4: doc.r4 ?? undefined,
      s1: doc.s1,
      s2: doc.s2,
      s3: doc.s3,
      s4: doc.s4 ?? undefined,
      computedAt: doc.computed_at,
    };

    if (!latestPivots[symbol]) latestPivots[symbol] = {};
    if (!latestPivots[symbol][timeframe]) latestPivots[symbol][timeframe] = {};
    latestPivots[symbol][timeframe][method] = levels;

    return levels;
  }

  // Fallback: If no pivot exists in DB, fetch the last completed candle to calculate pivots
  let lastCandle = null;
  try {
    lastCandle = await FuturesOHLC.findOne({ symbol, timeframe }).sort({ bar_time: -1 });
  } catch (err) {
    // Suppress warning when offline
  }

  if (lastCandle) {
    const computed = await recalculatePivots(
      symbol,
      timeframe,
      lastCandle.bar_high,
      lastCandle.bar_low,
      lastCandle.bar_close
    );
    return computed[method];
  } else {
    // Fallback: Calculate pivots using the current cached LTP if DB is offline
    const rawFutLtp = await readLive(`ltp:${symbol}`);
    const currentPrice = rawFutLtp ? parseFloat(rawFutLtp) : 22100;
    const computed = await recalculatePivots(
      symbol,
      timeframe,
      currentPrice + 50,
      currentPrice - 50,
      currentPrice
    );
    return computed[method];
  }

  return null;
};

/**
 * Evaluates current indicators (Call/Put states) for a symbol, timeframe and pivot method
 */
export const evaluateIndicators = async (
  symbol: string,
  timeframe: string,
  method: "classic" | "camarilla" | "fibonacci",
  spotSymbol = "NIFTY-SPOT"
): Promise<Module1Indicators | null> => {
  try {
    // 1. Fetch latest prices — memory-first (this runs up to 2×/sec per active
    // indicator room; per-eval Redis GETs were pure quota waste).
    const rawFutLtp = await readLive(`ltp:${symbol}`);
    const rawSpotLtp = await readLive(`ltp:${spotSymbol}`);

    if (!rawFutLtp || !rawSpotLtp) {
      return null;
    }

    const futLtp = parseFloat(rawFutLtp);
    const spotLtp = parseFloat(rawSpotLtp);

    // 2. Fetch the active pivots
    const pivots = await getPivotLevels(symbol, timeframe, method);
    if (!pivots) {
      return null;
    }

    // 3. Compute indicators
    const divergencePct = getDivergence(spotLtp, futLtp);
    const callState = getCallIndicator(
      futLtp,
      { P: pivots.pivot, R1: pivots.r1, S1: pivots.s1 },
      spotLtp
    );
    const putState = getPutIndicator(
      futLtp,
      { P: pivots.pivot, R1: pivots.r1, S1: pivots.s1 },
      spotLtp
    );

    return {
      symbol,
      callState,
      putState,
      divergencePct,
      hasDivergenceWarning: divergencePct > 0.5,
      computedAt: new Date(),
    };
  } catch (error) {
    console.error("Error evaluating indicators:", error);
    return null;
  }
};
