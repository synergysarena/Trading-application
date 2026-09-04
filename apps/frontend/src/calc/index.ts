// Pure TypeScript calculation engine — no React imports.

export interface OHLCBar {
  t: number; // unix ms
  o: number;
  h: number;
  l: number;
  c: number;
  // Optional: only the Future bar carries a real traded volume today (Call/Put
  // premiums and the Spot index either lack it or aren't sourced here).
  // Undefined means "no volume data for this bar", not zero.
  volume?: number;
  isSynthetic?: boolean;
}

export interface PivotLevels {
  pp: number;
  r1: number; r2: number; r3: number;
  s1: number; s2: number; s3: number;
}

export interface RatingResult {
  value: number;
  label: "Strong Sell" | "Sell" | "Hold" | "Buy" | "Strong Buy";
}

export interface FibLevel {
  label: string;
  value: number;
}

// Snapshot of the OI matrix at the moment a row is assembled.
export interface OiSnapshot {
  tin: number;
  c_tl: number; c_mn: number; c_hig: number; c_low: number;
  c_buy: number; c_sell: number;
  f_buy: number; f_sell: number;
  p_tl: number; p_mn: number; p_hig: number; p_low: number;
  p_buy: number; p_sell: number;
  callSignal: string;
  putSignal: string;
  dataSource: string;
}

// ── Dashboard row model (v2 — 31-column spec) ─────────────────────────────────
// Each row represents one completed (or live-forming) bar of the active timeframe.

export interface DashboardRow {
  t: number;
  // Per-side full OHLC bars
  call:   OHLCBar;   // CE option premium
  put:    OHLCBar;   // PE option premium
  future: OHLCBar;   // NIFTY-FUT
  spot:   OHLCBar;   // NIFTY-SPOT (falls back to NIFTY-FUT when Spot unavailable)
  // Pre-computed MA (formerly MMA) and TMA for all four sides
  callMMA:   number;
  callTMA:   number;
  putMMA:    number;
  putTMA:    number;
  futureMMA: number;
  futureTMA: number;
  spotMMA:   number;
  spotTMA:   number;
  // Ranking — the higher of Call MMA vs Put MMA, plus which side won (for cell colour)
  ranking:       number;
  rankingWinner: "call" | "put";
  // Indicators
  smc:  string;
  fib:  string;
  rsi:  number | null;
  ema:  number | null;   // EMA-20 of Spot Close
  vwap: number | null;   // True VWAP = Σ(TP×Volume)/ΣVolume on Future bars; null until volume is available
  // EMA20 vs EMA200 / VWAP vs EMA20 scoring (client EMA & VWAP spec) — null until inputs are warmed up
  ema200:     number | null; // EMA-200 of Spot Close, same engine/source as `ema`, period 200
  emaScore:   ScoreSign | null; // compareScore(ema, ema200)
  vwapScore:  ScoreSign | null; // compareScore(vwap, ema)
  totalScore: number | null;    // emaScore + vwapScore
  rating:     Rating | null;    // 5-level mapping of totalScore
  signal:     Signal | null;    // 3-level mapping of totalScore
  // OI snapshot (kept for Module 1 OI sidebar)
  oiMatrix: OiSnapshot | null;
}

// ── Legacy pivot calculations (kept for reference; not used in v2 row builder) ─

export function clientPivot4Bar(bar: OHLCBar): PivotLevels {
  const pp = (bar.o + bar.h + bar.l + bar.c) / 4;
  return {
    pp,
    r1: 2 * pp - bar.l,  r2: pp + (bar.h - bar.l),  r3: bar.h + 2 * (pp - bar.l),
    s1: 2 * pp - bar.h,  s2: pp - (bar.h - bar.l),  s3: bar.l - 2 * (bar.h - pp),
  };
}

export function classicPivot(bar: OHLCBar): PivotLevels {
  const pp = (bar.h + bar.l + bar.c) / 3;
  return {
    pp,
    r1: 2 * pp - bar.l,  r2: pp + (bar.h - bar.l),  r3: bar.h + 2 * (pp - bar.l),
    s1: 2 * pp - bar.h,  s2: pp - (bar.h - bar.l),  s3: bar.l - 2 * (bar.h - pp),
  };
}

// ── Pivot Points (PP / R1-R3 / S1-S3) — worksheet columns ─────────────────────
// Dispatches to whichever of the two formulas above the user has selected
// (dashboard store's pivotMethod), evaluated against a single OHLC bar — the
// same per-candle bar already used for that row's MMA/TLA. No new formulas;
// this only selects between the two existing exported functions.
export type PivotMethod = "client" | "classic";

export function pivotForBar(method: PivotMethod, bar: OHLCBar): PivotLevels | null {
  if (!Number.isFinite(bar.o) || !Number.isFinite(bar.h) || !Number.isFinite(bar.l) || !Number.isFinite(bar.c)) {
    return null;
  }
  return method === "classic" ? classicPivot(bar) : clientPivot4Bar(bar);
}

// ── MA (formerly MMA) / TMA ──────────────────────────────────────────────────
// Client formula (v3 spec, 2026-07-22): MA = (O + H + L + (MMA_CLOSE_SIGN × C)) / 4
// with MMA_CLOSE_SIGN = +1, i.e. MA = (O + H + L + C) / 4 — an intentional
// business-rule change from the prior (O + H + L − C) / 4. Applies uniformly
// to Call/Put/Future/Spot MA since all four sides call this same function.
export const MMA_CLOSE_SIGN = 1 as const;

export function mmaBar(bar: OHLCBar): number {
  return (bar.o + bar.h + bar.l + MMA_CLOSE_SIGN * bar.c) / 4;
}

// TMA (replaces the old TLA = 2×MMA − H, removed per final client spec):
//   TMA = Σ(i=1→N)(Oi + Hi + Li + Ci) / (4 × N)
// cumulative from the first candle of the displayed series through candle N.
// Bars with missing data (NaN OHLC) contribute nothing — neither to the sum
// nor to N — so one missing option bar never poisons the rest of the column.
export interface TmaState { sum: number; count: number; }

export const newTmaState = (): TmaState => ({ sum: 0, count: 0 });

const barOhlcSum = (bar: OHLCBar): number => bar.o + bar.h + bar.l + bar.c;

// Folds a CLOSED bar into the running state (mutates the state).
export function tmaAccumulate(state: TmaState, bar: OHLCBar): void {
  const s = barOhlcSum(bar);
  if (Number.isFinite(s)) {
    state.sum += s;
    state.count += 1;
  }
}

// TMA over the accumulated closed bars, optionally including a still-forming
// bar (which is NOT folded into the state — it changes every tick and is only
// committed via tmaAccumulate once its window closes).
export function tmaValue(state: TmaState, formingBar?: OHLCBar): number {
  let { sum, count } = state;
  if (formingBar) {
    const s = barOhlcSum(formingBar);
    if (Number.isFinite(s)) {
      sum += s;
      count += 1;
    }
  }
  return count > 0 ? sum / (4 * count) : NaN;
}

// ── Ranking ───────────────────────────────────────────────────────────────────
// Compares Call MMA vs Put MMA only (Future/Spot not included).
// Tie (diff = 0) goes to Call MMA — confirmed by client.
// If only one side has data (NaN = missing option bar), the available side wins
// outright; if both are missing, returns 0 so the result is always a finite
// number — never NaN / undefined / null / Infinity.
export function computeRanking(callMMA: number, putMMA: number): { value: number; winner: "call" | "put" } {
  const callValid = Number.isFinite(callMMA);
  const putValid  = Number.isFinite(putMMA);
  if (callValid && putValid) {
    return callMMA - putMMA >= 0
      ? { value: callMMA, winner: "call" }
      : { value: putMMA, winner: "put" };
  }
  if (callValid) return { value: callMMA, winner: "call" };
  if (putValid)  return { value: putMMA,  winner: "put"  };
  return { value: 0, winner: "call" };
}

// ── EMA ───────────────────────────────────────────────────────────────────────
// Period defaults to 20 (CONFIRM with client).
// Source: Spot Close; caller falls back to Future Close if Spot unavailable.
// Seeded with SMA of the first `period` values; returns null until seeded.
export function computeEMASeries(closes: number[], period = 20): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let ema: number | null = null;
  let seedSum = 0;

  for (let i = 0; i < closes.length; i++) {
    seedSum += closes[i];
    if (i < period - 1) {
      out.push(null);
    } else if (i === period - 1) {
      ema = seedSum / period;
      out.push(ema);
    } else {
      ema = closes[i] * k + ema! * (1 - k);
      out.push(ema);
    }
  }
  return out;
}

// ── VWAP ──────────────────────────────────────────────────────────────────────
// True volume-weighted VWAP = Σ(TP × Volume) / ΣVolume, TP = (H+L+C)/3.
// Source: Future bars (the tradable instrument with real broker volume) —
// the Spot index has no traded volume, so VWAP is no longer sourced from it.
// Resets every session (caller is responsible for feeding only today's bars).
// A bar is a null cumulative value until ΣVolume > 0 — never fabricate a VWAP
// from unweighted price when volume is unavailable.
export function computeVWAPSeries(bars: OHLCBar[]): (number | null)[] {
  const out: (number | null)[] = [];
  let cumTPV = 0; // Σ(TP × Volume)
  let cumV = 0;   // ΣVolume
  for (let i = 0; i < bars.length; i++) {
    const { h, l, c, volume } = bars[i];
    const v = volume ?? 0;
    cumTPV += ((h + l + c) / 3) * v;
    cumV += v;
    out.push(cumV > 0 ? cumTPV / cumV : null);
  }
  return out;
}

// ── EMA20 vs EMA200 / VWAP vs EMA20 scoring (client EMA & VWAP spec) ──────────
// EMA200 reuses computeEMASeries(closes, 200) — same engine and source as EMA20,
// just a longer period. Score is +1 when the first value is above the second,
// -1 when below, 0 when equal; null when either input isn't available yet
// (e.g. EMA200 still warming up, or VWAP/EMA20 not seeded).
export type ScoreSign = -1 | 0 | 1;

export function compareScore(a: number | null, b: number | null): ScoreSign | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

// Total Score = EMA Score + VWAP Score. Null unless both scores are available.
export function totalScoreFromParts(emaScore: ScoreSign | null, vwapScore: ScoreSign | null): number | null {
  if (emaScore == null || vwapScore == null) return null;
  return emaScore + vwapScore;
}

export type Rating = "Strong CALL" | "CALL" | "Neutral" | "PUT" | "Strong PUT";

// +2 → Strong CALL · +1 → CALL · 0 → Neutral · -1 → PUT · -2 → Strong PUT
export function ratingFromTotalScore(score: number | null): Rating | null {
  switch (score) {
    case  2: return "Strong CALL";
    case  1: return "CALL";
    case  0: return "Neutral";
    case -1: return "PUT";
    case -2: return "Strong PUT";
    default: return null;
  }
}

export type Signal = "BUY CALL" | "WAIT" | "BUY PUT" | "STRONG BUY PUT";

// Rating → Signal (client spec — intentionally asymmetric: Strong CALL and
// CALL both read as "BUY CALL", but Strong PUT gets its own "STRONG BUY PUT"
// distinct from plain PUT's "BUY PUT").
export function signalFromRating(rating: Rating | null): Signal | null {
  switch (rating) {
    case "Strong CALL": return "BUY CALL";
    case "CALL":         return "BUY CALL";
    case "Neutral":      return "WAIT";
    case "PUT":          return "BUY PUT";
    case "Strong PUT":   return "STRONG BUY PUT";
    default:             return null;
  }
}

// ── RSI (Wilder) ─────────────────────────────────────────────────────────────

export function computeRsiSeries(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = [];
  if (closes.length === 0) return result;

  for (let i = 0; i < Math.min(period, closes.length); i++) result.push(null);
  if (closes.length <= period) return result;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain += Math.max(ch, 0);
    avgLoss += Math.max(-ch, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

// ── Fibonacci retracement ─────────────────────────────────────────────────────

const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786];

export function fibLevels(high: number, low: number): FibLevel[] {
  const diff = high - low;
  return FIB_RATIOS.map(r => ({ label: `${(r * 100).toFixed(1)}%`, value: high - diff * r }));
}

export function nearestFibLabel(price: number, high: number, low: number): string | null {
  if (high <= low) return null;
  const levels = fibLevels(high, low);
  const nearest = levels.reduce((best, lvl) =>
    Math.abs(lvl.value - price) < Math.abs(best.value - price) ? lvl : best
  );
  // useGrouping: false — Indicator-section display spec: no thousands separators.
  // Same precision/value as before; only the comma grouping is removed.
  return `${nearest.label} ${nearest.value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })}`;
}

// ── SMC structural levels ─────────────────────────────────────────────────────

export function smcNearest(
  close: number,
  swHigh: number,
  swLow: number,
  pdh: number,
  pdl: number,
): string {
  const candidates = [
    { label: "SWH", value: swHigh },
    { label: "SWL", value: swLow },
    { label: "PDH", value: pdh },
    { label: "PDL", value: pdl },
  ];
  const nearest = candidates.reduce((best, c) =>
    Math.abs(c.value - close) < Math.abs(best.value - close) ? c : best
  );
  // useGrouping: false — Indicator-section display spec: no thousands separators.
  // Same precision/value as before; only the comma grouping is removed.
  return `${nearest.label} ${nearest.value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })}`;
}

// ── Rating engine (kept for backward compat; not used in v2 DashboardRow) ─────

export function aggregateRating(votes: number[]): RatingResult {
  const v = votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : 0;
  const label: RatingResult["label"] =
    v < -0.5 ? "Strong Sell" :
    v < -0.1 ? "Sell"        :
    v <=  0.1 ? "Hold"       :
    v <=  0.5 ? "Buy"        : "Strong Buy";
  return { value: v, label };
}
