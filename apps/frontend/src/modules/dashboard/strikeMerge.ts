import type { OHLCBar, DashboardRow, TmaState } from "../../calc";
import { mmaBar, computeRanking, newTmaState, tmaAccumulate, tmaValue } from "../../calc";

// Sentinel for a bar with no data — mirrors index.tsx's MISSING_BAR so a row
// with no option candle for its timestamp renders "—", never a fabricated value.
export const MISSING_BAR = (t: number): OHLCBar => ({ t, o: NaN, h: NaN, l: NaN, c: NaN });

/**
 * THE canonical minute/bucket key used for every history↔row match in Module 1.
 *
 * A worksheet row's `t` and a stored candle's `openTime` are both meant to be
 * exact multiples of the timeframe (`Math.floor(x / tfMs) * tfMs`). This snaps
 * either side back onto that grid so a few ms / a sub-boundary timestamp on one
 * side can never turn a real, stored candle into a "—". Identity for
 * already-aligned values, so it is safe to apply everywhere.
 */
export const bucketKey = (t: number, tfMs: number): number =>
  tfMs > 0 ? Math.floor(t / tfMs) * tfMs : t;

/** Index a fetched candle series by its canonical bucket key. Last write wins
 *  (a later / more-complete candle for the same bucket supersedes an earlier). */
export const buildBucketMap = (
  bars: OHLCBar[] | null | undefined,
  tfMs: number,
): Map<number, OHLCBar> => {
  const m = new Map<number, OHLCBar>();
  if (!bars) return m;
  for (const b of bars) {
    if (b && Number.isFinite(b.t)) m.set(bucketKey(b.t, tfMs), b);
  }
  return m;
};

/**
 * Expand a fetched FUT/SPOT series into a GAP-FREE bucket grid, from its first
 * bar through (but excluding) `endExclusive`.
 *
 * This is the base market timeline: EVERY trading minute is present. A bucket
 * the API did not return carries the previous close forward as a flat bar
 * (`isSynthetic: true`) — the exact rule the backend already applies to
 * NIFTY-FUT / NIFTY-SPOT, applied client-side as a safety net so a hole in the
 * API response can never make a minute row disappear from the worksheet.
 *
 * Option series are NEVER passed here — a missing option candle stays "—".
 */
export const fillGridSeries = (
  bars: OHLCBar[] | null | undefined,
  tfMs: number,
  endExclusive: number,
): OHLCBar[] => {
  const clean = (bars ?? [])
    .filter((b): b is OHLCBar => !!b && Number.isFinite(b.t))
    .sort((a, b) => a.t - b.t);
  if (clean.length === 0 || tfMs <= 0) return clean;

  const byBucket = new Map<number, OHLCBar>();
  for (const b of clean) byBucket.set(bucketKey(b.t, tfMs), b);

  const start = bucketKey(clean[0].t, tfMs);
  const end = bucketKey(endExclusive, tfMs);
  if (end <= start) return [byBucket.get(start) ?? clean[0]];

  const out: OHLCBar[] = [];
  let prevClose = Number.isFinite(clean[0].o) ? clean[0].o : clean[0].c;
  for (let t = start; t < end; t += tfMs) {
    const real = byBucket.get(t);
    if (real) {
      out.push(real);
      if (Number.isFinite(real.c)) prevClose = real.c;
    } else {
      out.push({ t, o: prevClose, h: prevClose, l: prevClose, c: prevClose, volume: 0, isSynthetic: true });
    }
  }
  return out;
};

/**
 * The exclusive end of the market-timeline grid: the live window, but never
 * more than `tailGraceMs` past the last real FUT bar. Keeps the grid from
 * padding hundreds of flat rows after the market closes (last bar ~15:30 IST)
 * while never truncating a live session — NIFTY-FUT does not go 20 min without
 * a tick during trading hours.
 */
export const gridEndFor = (
  closedFutBars: OHLCBar[],
  tfMs: number,
  liveWindowStart: number,
  tailGraceMs = 20 * 60_000,
): number => {
  if (closedFutBars.length === 0) return liveWindowStart;
  let lastT = -Infinity;
  for (const b of closedFutBars) if (b && Number.isFinite(b.t) && b.t > lastT) lastT = b.t;
  if (!Number.isFinite(lastT)) return liveWindowStart;
  return Math.min(liveWindowStart, bucketKey(lastT, tfMs) + tfMs + tailGraceMs);
};

/**
 * Resolve the Call/Put option bars for one worksheet row.
 *
 * The stored candle for the row's bucket is used whenever it exists — matched
 * through `bucketKey`, so it is returned even if the API's `openTime` drifted a
 * few seconds off the boundary. Only a bucket with NO stored candle yields
 * MISSING_BAR ("—"); missing minutes are never back-filled.
 */
export const resolveRowOptionBars = (
  rowT: number,
  ceMap: Map<number, OHLCBar>,
  peMap: Map<number, OHLCBar>,
  tfMs: number,
): { callBar: OHLCBar; putBar: OHLCBar } => {
  const k = bucketKey(rowT, tfMs);
  return {
    callBar: ceMap.get(k) ?? MISSING_BAR(rowT),
    putBar: peMap.get(k) ?? MISSING_BAR(rowT),
  };
};

/**
 * Re-overlay EXACTLY ONE option side (CE or PE) onto the existing worksheet
 * rows — for a newly selected Call **or** Put strike.
 *
 * Independence guarantees:
 *  - Changing the Call strike calls this with side="call": only `call`,
 *    `callMMA`, `callTMA` (+ `ranking`, which by spec is max(callMMA, putMMA))
 *    are rewritten. `put`, `putMMA`, `putTMA`, FUT, SPOT and every indicator
 *    column are copied through byte-for-byte. Changing Put is the mirror.
 *  - Row identity / order / count are preserved 1:1 — the timeline cannot
 *    collapse because this never adds or drops a row.
 *  - `bars` is the selected strike's own fetched history. A bucket with no
 *    stored candle becomes MISSING_BAR ("—"); option data is NEVER fabricated
 *    or carried forward.
 *
 * Returns the rebuilt rows plus the cumulative TMA state through the last
 * CLOSED row so the live updater continues that side's column seamlessly.
 */
export const overlayOptionSide = (
  rows: DashboardRow[],
  side: "call" | "put",
  bars: OHLCBar[] | null | undefined,
  tfMs: number,
  liveWindowStart: number,
): { rows: DashboardRow[]; tma: TmaState } => {
  const map = buildBucketMap(bars, tfMs);
  const tma = newTmaState();

  const out = rows.map((row) => {
    const bar = map.get(bucketKey(row.t, tfMs)) ?? MISSING_BAR(row.t);
    const isClosed = row.t < liveWindowStart;
    if (isClosed) tmaAccumulate(tma, bar);
    const mma = mmaBar(bar);
    const tmaVal = isClosed ? tmaValue(tma) : tmaValue(tma, bar);

    if (side === "call") {
      const { value, winner } = computeRanking(mma, row.putMMA);
      return { ...row, call: bar, callMMA: mma, callTMA: tmaVal, ranking: value, rankingWinner: winner };
    }
    const { value, winner } = computeRanking(row.callMMA, mma);
    return { ...row, put: bar, putMMA: mma, putTMA: tmaVal, ranking: value, rankingWinner: winner };
  });

  return { rows: out, tma };
};
