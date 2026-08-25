import { marketDataEvents } from "./marketDataEvents";
import { NormalizedMarketEvent } from "./marketDataPipelineService";
import { getByInstrumentId } from "./marketDataCacheService";

/**
 * Minute Aggregation Engine (Phase 9).
 *
 * Consumes MARKET_DATA events and builds 1-minute OHLC candles, per
 * instrument, entirely in memory. No database writes, no indicators — just
 * Open/High/Low/Close/Volume/OI/tick-count bucketed by wall-clock minute.
 *
 * Consumers (REST controllers today, a future Formula Engine later) only
 * ever read through this file's exported getters or its published events —
 * never the internal Maps below.
 */

export interface MinuteCandle {
  exchangeSegment: number | null;
  exchangeInstrumentID: string;
  tradingSymbol: string | null;
  minuteStartTime: string; // ISO, floored to :00
  minuteEndTime: string; // ISO, minuteStartTime + 60s
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  openInterest: number | null;
  tickCount: number;
}

export interface CandleStats {
  activeCandles: number;
  totalCandlesCompleted: number;
  totalTicksProcessed: number;
  lastCandleCompletedAt: string | null;
}

// Candle currently being built for each instrument (mutated in place as ticks arrive).
const currentByInstrument = new Map<string, MinuteCandle>();
// Most recently finalized candle per instrument, kept so /candles/:instrumentId still
// has something to return in the gap between a candle completing and its successor's first tick.
const lastCompletedByInstrument = new Map<string, MinuteCandle>();

let totalCandlesCompleted = 0;
let totalTicksProcessed = 0;
let lastCandleCompletedAt: Date | null = null;
let boundarySweepTimer: NodeJS.Timeout | null = null;
let initialized = false;

const floorToMinuteIso = (iso: string): string => {
  const d = new Date(iso);
  d.setSeconds(0, 0);
  return d.toISOString();
};

const addOneMinuteIso = (isoMinuteStart: string): string =>
  new Date(new Date(isoMinuteStart).getTime() + 60_000).toISOString();

/** Publishes a shallow copy so external listeners can never mutate engine-internal state. */
const emitCandleEvent = (name: "CANDLE_STARTED" | "CANDLE_UPDATED" | "CANDLE_COMPLETED", candle: MinuteCandle) => {
  marketDataEvents.emit(name, { ...candle });
};

/** Finalizes whatever candle is currently open for an instrument, if any (Step 4). */
const finalizeCandle = (exchangeInstrumentID: string): void => {
  const candle = currentByInstrument.get(exchangeInstrumentID);
  if (!candle) return;

  currentByInstrument.delete(exchangeInstrumentID);
  lastCompletedByInstrument.set(exchangeInstrumentID, candle);
  totalCandlesCompleted += 1;
  lastCandleCompletedAt = new Date();

  emitCandleEvent("CANDLE_COMPLETED", candle);
};

/** Starts a brand-new candle from a price-bearing tick — Step 3's "first tick of minute → Open". */
const startCandle = (event: NormalizedMarketEvent, minuteStartTime: string): MinuteCandle => {
  const price = event.lastPrice as number; // caller guarantees non-null
  const tradingSymbol = getByInstrumentId(event.exchangeInstrumentID!)?.tradingSymbol ?? null;

  const candle: MinuteCandle = {
    exchangeSegment: event.exchangeSegment,
    exchangeInstrumentID: event.exchangeInstrumentID!,
    tradingSymbol,
    minuteStartTime,
    minuteEndTime: addOneMinuteIso(minuteStartTime),
    open: price,
    high: price,
    low: price,
    close: price,
    volume: event.volume,
    openInterest: event.openInterest,
    tickCount: 1,
  };

  currentByInstrument.set(event.exchangeInstrumentID!, candle);
  emitCandleEvent("CANDLE_STARTED", candle);
  return candle;
};

/**
 * Per-tick minute boundary detection (Step 4): the primary correctness path.
 * Comparing each tick's own minute bucket against the instrument's open
 * candle handles instruments independently and is immune to broker timer
 * jitter — an instrument that goes quiet simply keeps its last candle open
 * until its next tick (whenever that is), at which point this same check
 * rolls it over. The wall-clock sweep below exists only to close out candles
 * promptly for instruments that go quiet rather than leaving them open
 * indefinitely waiting for a tick that may never come.
 */
export const handleMarketDataEvent = (event: NormalizedMarketEvent): void => {
  const id = event.exchangeInstrumentID;
  if (!id || !event.timestamp) return; // the pipeline already guarantees these; defensive only

  totalTicksProcessed += 1;
  const tickMinuteStart = floorToMinuteIso(event.timestamp);

  let candle = currentByInstrument.get(id);

  if (candle && candle.minuteStartTime !== tickMinuteStart) {
    finalizeCandle(id);
    candle = undefined;
  }

  if (event.lastPrice !== null) {
    if (!candle) {
      candle = startCandle(event, tickMinuteStart);
      return; // the tick that starts a candle publishes CANDLE_STARTED, not also CANDLE_UPDATED
    }

    candle.high = Math.max(candle.high, event.lastPrice);
    candle.low = Math.min(candle.low, event.lastPrice);
    candle.close = event.lastPrice;
    candle.tickCount += 1;
    if (event.volume !== null) candle.volume = event.volume;
    if (event.openInterest !== null) candle.openInterest = event.openInterest;
    if (event.exchangeSegment !== null) candle.exchangeSegment = event.exchangeSegment;
    emitCandleEvent("CANDLE_UPDATED", candle);
    return;
  }

  // OI/volume-only tick (e.g. a 1510 packet): attach to an already-open candle.
  // With no price to open a candle with, a tick that arrives before this
  // instrument's first price tick of the minute is dropped — see Known
  // Limitations in the Phase 9 report.
  if (candle) {
    if (event.volume !== null) candle.volume = event.volume;
    if (event.openInterest !== null) candle.openInterest = event.openInterest;
    emitCandleEvent("CANDLE_UPDATED", candle);
  }
};

/** Wall-clock sweep — fires at every HH:mm:00 and closes out any candle the tick-level check hasn't already rolled over. */
const sweepStaleCandles = (): void => {
  const currentMinute = floorToMinuteIso(new Date().toISOString());
  for (const [id, candle] of Array.from(currentByInstrument.entries())) {
    if (candle.minuteStartTime !== currentMinute) {
      finalizeCandle(id);
    }
  }
};

const scheduleNextBoundarySweep = (): void => {
  const delay = 60_000 - (Date.now() % 60_000);
  boundarySweepTimer = setTimeout(() => {
    sweepStaleCandles();
    scheduleNextBoundarySweep();
  }, delay);
};

export const getCurrentCandles = (): MinuteCandle[] =>
  Array.from(currentByInstrument.values()).map((c) => ({ ...c }));

export const getCandleForInstrument = (exchangeInstrumentID: string): MinuteCandle | undefined => {
  const current = currentByInstrument.get(exchangeInstrumentID);
  if (current) return { ...current };
  const completed = lastCompletedByInstrument.get(exchangeInstrumentID);
  return completed ? { ...completed } : undefined;
};

export const getCandleStats = (): CandleStats => ({
  activeCandles: currentByInstrument.size,
  totalCandlesCompleted,
  totalTicksProcessed,
  lastCandleCompletedAt: lastCandleCompletedAt ? lastCandleCompletedAt.toISOString() : null,
});

export const clearCandles = (): void => {
  currentByInstrument.clear();
  lastCompletedByInstrument.clear();
  totalCandlesCompleted = 0;
  totalTicksProcessed = 0;
  lastCandleCompletedAt = null;
};

/** Called once at server startup. Idempotent — a second call is a no-op. */
export const initMinuteAggregation = (): void => {
  if (initialized) return;
  initialized = true;

  marketDataEvents.on("MARKET_DATA", handleMarketDataEvent);
  scheduleNextBoundarySweep();

  console.log("[MinuteAggregation] Initialized — building 1-minute OHLC candles from MARKET_DATA events.");
};

/** Stops the boundary sweep timer — mainly useful for tests so the process can exit cleanly. */
export const stopMinuteAggregation = (): void => {
  if (boundarySweepTimer) {
    clearTimeout(boundarySweepTimer);
    boundarySweepTimer = null;
  }
};
