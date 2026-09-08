/**
 * Module 1 OHLC data-flow AUDIT instrumentation (development / diagnostic only).
 *
 * Enabled with `MODULE1_OHLC_AUDIT=true`. Off by default → zero overhead on the
 * live tick hot path (the callers guard every call with isOhlcAuditEnabled()).
 *
 * It records, per (symbol, clock-minute), how many normalized ticks entered the
 * Module 1 pipeline and how many DISTINCT prices they carried — so that when a
 * flat 1-minute candle (open=high=low=close) is finalized, the log line proves
 * whether the feed genuinely delivered one price that minute or whether ticks
 * were lost somewhere between the pipeline and the aggregator.
 *
 * Standalone module (no imports from dataFeed / ohlcAggregator) to avoid a
 * circular dependency — both of those import from here.
 */

export const isOhlcAuditEnabled = (): boolean => process.env.MODULE1_OHLC_AUDIT === "true";

interface MinuteBucket {
  count: number;
  prices: Set<number>;
  first: number;
  last: number;
  firstAtMs: number;
  lastAtMs: number;
}

// key = `${symbol}|${minuteStartMs}`
const pipeline = new Map<string, MinuteBucket>();
const RETAIN_MS = 20 * 60 * 1000; // keep ~20 minutes of buckets

let lastPrune = 0;
const prune = (nowMs: number) => {
  if (nowMs - lastPrune < 60_000) return;
  lastPrune = nowMs;
  const cutoff = nowMs - RETAIN_MS;
  for (const [k] of pipeline) {
    const minuteStartMs = Number(k.split("|")[1]);
    if (Number.isFinite(minuteStartMs) && minuteStartMs < cutoff) pipeline.delete(k);
  }
};

const minuteKey = (symbol: string, tsMs: number) => `${symbol}|${tsMs - (tsMs % 60_000)}`;

/** Called for every normalized tick that reaches processIncomingTick(). */
export const recordPipelineTick = (symbol: string, tickTsMs: number, price: number, receivedAtMs = Date.now()) => {
  if (!isOhlcAuditEnabled()) return;
  const key = minuteKey(symbol, tickTsMs);
  let b = pipeline.get(key);
  if (!b) {
    b = { count: 0, prices: new Set(), first: price, last: price, firstAtMs: receivedAtMs, lastAtMs: receivedAtMs };
    pipeline.set(key, b);
  }
  b.count += 1;
  b.prices.add(price);
  b.last = price;
  b.lastAtMs = receivedAtMs;
  prune(receivedAtMs);
};

export interface PipelineMinuteAudit {
  pipelineTicks: number;
  uniquePrices: number;
  firstPrice: number | null;
  lastPrice: number | null;
  spanMs: number;
}

export const getPipelineMinute = (symbol: string, minuteStartMs: number): PipelineMinuteAudit => {
  const b = pipeline.get(`${symbol}|${minuteStartMs}`);
  if (!b) return { pipelineTicks: 0, uniquePrices: 0, firstPrice: null, lastPrice: null, spanMs: 0 };
  return {
    pipelineTicks: b.count,
    uniquePrices: b.prices.size,
    firstPrice: b.first,
    lastPrice: b.last,
    spanMs: b.lastAtMs - b.firstAtMs,
  };
};

// Hard per-process cap so a forgotten MODULE1_OHLC_AUDIT=true can never flood logs.
let emitted = 0;
const MAX_LINES = Number(process.env.MODULE1_OHLC_AUDIT_MAX_LINES) || 600;

export const auditLog = (line: string) => {
  if (!isOhlcAuditEnabled()) return;
  if (emitted >= MAX_LINES) {
    if (emitted === MAX_LINES) {
      console.log(`[MODULE1][OHLC-AUDIT] line cap (${MAX_LINES}) reached — further audit lines suppressed this process.`);
      emitted++;
    }
    return;
  }
  emitted++;
  console.log(line);
};

/** Test-only. */
export const __resetOhlcAudit = () => {
  pipeline.clear();
  emitted = 0;
  lastPrune = 0;
};
