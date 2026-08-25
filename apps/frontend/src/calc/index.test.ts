// Formula validation for the Module 1 calculation engine.
// Every expected value is derived by an independent inline implementation of
// the agreed business formula, so these tests catch drift in either direction.

import { describe, it, expect } from "vitest";
import {
  computeRanking,
  computeRsiSeries,
  computeEMASeries,
  computeVWAPSeries,
  mmaBar,
  newTmaState,
  tmaAccumulate,
  tmaValue,
  MMA_CLOSE_SIGN,
  compareScore,
  totalScoreFromParts,
  ratingFromTotalScore,
  signalFromRating,
  type OHLCBar,
} from "./index";

const bar = (t: number, o: number, h: number, l: number, c: number, volume?: number): OHLCBar =>
  ({ t, o, h, l, c, volume });

// ── Ranking ───────────────────────────────────────────────────────────────────

describe("computeRanking", () => {
  it("CE + PE: winner is the larger MMA, tie goes to call", () => {
    expect(computeRanking(120, 80)).toEqual({ value: 120, winner: "call" });
    expect(computeRanking(80, 120)).toEqual({ value: 120, winner: "put" });
    expect(computeRanking(100, 100)).toEqual({ value: 100, winner: "call" });
  });

  it("CE only (Put MMA = NaN): returns the Call MMA, never NaN", () => {
    const r = computeRanking(115.25, NaN);
    expect(r).toEqual({ value: 115.25, winner: "call" });
    expect(Number.isFinite(r.value)).toBe(true);
  });

  it("PE only (Call MMA = NaN): returns the Put MMA, never NaN", () => {
    const r = computeRanking(NaN, 98.5);
    expect(r).toEqual({ value: 98.5, winner: "put" });
    expect(Number.isFinite(r.value)).toBe(true);
  });

  it("missing CE and PE: still returns a finite value", () => {
    const r = computeRanking(NaN, NaN);
    expect(Number.isFinite(r.value)).toBe(true);
  });

  it("never returns Infinity even for Infinity inputs", () => {
    expect(Number.isFinite(computeRanking(Infinity, 50).value)).toBe(true);
    expect(Number.isFinite(computeRanking(50, -Infinity).value)).toBe(true);
  });
});

// ── RSI (agreed business formula: 14-period seed, Wilder continuation) ────────

describe("computeRsiSeries", () => {
  const closes = [
    100, 101.5, 100.8, 102.2, 103.0, 102.4, 104.1, 105.0, 104.2, 106.3,
    107.1, 106.5, 108.0, 109.2, 108.4, 110.0, 109.1, 111.3, 112.0, 110.8,
  ];

  it("first RSI value matches AvgGain = ΣGains/14, RS = AvgGain/AvgLoss, RSI = 100 − 100/(1+RS)", () => {
    const period = 14;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch > 0) gains += ch; else losses += -ch;
    }
    const rs = (gains / period) / (losses / period);
    const expected = 100 - 100 / (1 + rs);

    const series = computeRsiSeries(closes);
    // First `period` slots are unseeded
    for (let i = 0; i < period; i++) expect(series[i]).toBeNull();
    expect(series[period]).toBeCloseTo(expected, 10);
  });

  it("continuation values follow Wilder smoothing", () => {
    const period = 14;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      avgGain += Math.max(ch, 0);
      avgLoss += Math.max(-ch, 0);
    }
    avgGain /= period;
    avgLoss /= period;

    const series = computeRsiSeries(closes);
    for (let i = period + 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
      const expected = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      expect(series[i]).toBeCloseTo(expected, 10);
    }
  });

  it("all-gains series pins RSI to 100 (AvgLoss = 0 guard)", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const series = computeRsiSeries(up);
    expect(series[series.length - 1]).toBe(100);
  });
});

// ── EMA: EMA = C×k + prevEMA×(1−k), k = 2/(N+1), SMA-seeded ───────────────────

describe("computeEMASeries", () => {
  const closes = Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 7) * 5 + i * 0.1);

  for (const period of [9, 20, 50, 200]) {
    it(`EMA ${period} matches manual SMA seed + recursive formula`, () => {
      const k = 2 / (period + 1);
      const series = computeEMASeries(closes, period);

      for (let i = 0; i < period - 1; i++) expect(series[i]).toBeNull();

      let expected = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
      expect(series[period - 1]).toBeCloseTo(expected, 10);

      for (let i = period; i < closes.length; i++) {
        expected = closes[i] * k + expected * (1 - k);
        expect(series[i]).toBeCloseTo(expected, 10);
      }
    });
  }

  it("live continuation from the historical seed equals recomputing the full series", () => {
    // Mirrors dashboard Effect 2: prevEmaRef seeded from history, then one
    // more close arrives and is folded in with the same k.
    const period = 20;
    const k = 2 / (period + 1);
    const history = closes.slice(0, 100);
    const nextClose = closes[100];

    const histSeries = computeEMASeries(history, period);
    const seed = histSeries[histSeries.length - 1]!;
    const continued = nextClose * k + seed * (1 - k);

    const fullSeries = computeEMASeries(closes.slice(0, 101), period);
    expect(continued).toBeCloseTo(fullSeries[fullSeries.length - 1]!, 10);
  });
});

// ── VWAP: true volume-weighted Σ(TP×Volume)/ΣVolume, TP = (H+L+C)/3 ───────────
// Sourced from Future bars, the tradable instrument with real broker volume.

describe("computeVWAPSeries", () => {
  const bars = [
    bar(0, 100, 102, 99, 101, 1000),
    bar(1, 101, 104, 100, 103, 1500),
    bar(2, 103, 103.5, 101, 102, 800),
    bar(3, 102, 105, 102, 104.5, 1200),
  ];

  it("each value equals cumulative Σ(TP×Volume) / cumulative ΣVolume", () => {
    const series = computeVWAPSeries(bars);
    let cumTPV = 0, cumV = 0;
    bars.forEach((b, i) => {
      cumTPV += ((b.h + b.l + b.c) / 3) * (b.volume ?? 0);
      cumV += b.volume ?? 0;
      expect(series[i]).toBeCloseTo(cumTPV / cumV, 10);
    });
  });

  it("live continuation state (cumTPV, cumV) matches the series", () => {
    // Mirrors dashboard Effect 2 vwapStateRef: history accumulates cumTPV/cumV,
    // then the live bar's TP×Volume is folded in.
    const history = bars.slice(0, 3);
    let cumTPV = 0, cumV = 0;
    history.forEach(b => {
      cumTPV += ((b.h + b.l + b.c) / 3) * (b.volume ?? 0);
      cumV += b.volume ?? 0;
    });
    const liveBar = bars[3];
    const liveTp = (liveBar.h + liveBar.l + liveBar.c) / 3;
    const liveV = liveBar.volume ?? 0;
    const liveVwap = (cumTPV + liveTp * liveV) / (cumV + liveV);

    const fullSeries = computeVWAPSeries(bars);
    expect(liveVwap).toBeCloseTo(fullSeries[fullSeries.length - 1]!, 10);
  });

  it("returns null while cumulative volume is zero — never a fake unweighted average", () => {
    const noVolumeBars = [
      bar(0, 100, 102, 99, 101),
      bar(1, 101, 104, 100, 103),
    ];
    const series = computeVWAPSeries(noVolumeBars);
    expect(series[0]).toBeNull();
    expect(series[1]).toBeNull();
  });

  it("becomes available the moment cumulative volume turns positive", () => {
    const mixedBars = [
      bar(0, 100, 102, 99, 101, 0),
      bar(1, 101, 104, 100, 103, 500),
    ];
    const series = computeVWAPSeries(mixedBars);
    expect(series[0]).toBeNull();
    expect(series[1]).toBeCloseTo((104 + 100 + 103) / 3, 10);
  });
});

// ── EMA20 vs EMA200 / VWAP vs EMA20 scoring (client EMA & VWAP spec) ──────────

describe("compareScore", () => {
  it("returns +1 when a > b, -1 when a < b, 0 when equal", () => {
    expect(compareScore(105, 100)).toBe(1);
    expect(compareScore(95, 100)).toBe(-1);
    expect(compareScore(100, 100)).toBe(0);
  });

  it("returns null when either input is missing", () => {
    expect(compareScore(null, 100)).toBeNull();
    expect(compareScore(100, null)).toBeNull();
    expect(compareScore(NaN, 100)).toBeNull();
  });
});

describe("totalScoreFromParts / ratingFromTotalScore / signalFromRating", () => {
  it("sums emaScore + vwapScore and maps to the 5-level rating", () => {
    expect(totalScoreFromParts(1, 1)).toBe(2);
    expect(ratingFromTotalScore(2)).toBe("Strong CALL");
    expect(totalScoreFromParts(1, 0)).toBe(1);
    expect(ratingFromTotalScore(1)).toBe("CALL");
    expect(totalScoreFromParts(1, -1)).toBe(0);
    expect(ratingFromTotalScore(0)).toBe("Neutral");
    expect(totalScoreFromParts(-1, 0)).toBe(-1);
    expect(ratingFromTotalScore(-1)).toBe("PUT");
    expect(totalScoreFromParts(-1, -1)).toBe(-2);
    expect(ratingFromTotalScore(-2)).toBe("Strong PUT");
  });

  it("maps rating to the asymmetric 4-level signal", () => {
    expect(signalFromRating("Strong CALL")).toBe("BUY CALL");
    expect(signalFromRating("CALL")).toBe("BUY CALL");
    expect(signalFromRating("Neutral")).toBe("WAIT");
    expect(signalFromRating("PUT")).toBe("BUY PUT");
    expect(signalFromRating("Strong PUT")).toBe("STRONG BUY PUT");
  });

  it("is null when either score / the rating is unavailable (e.g. EMA200 still warming up)", () => {
    expect(totalScoreFromParts(null, 1)).toBeNull();
    expect(ratingFromTotalScore(null)).toBeNull();
    expect(signalFromRating(null)).toBeNull();
  });
});

// ── MA / TMA (current client spec: MMA_CLOSE_SIGN = −1) ───────────────────────

describe("mmaBar / TMA", () => {
  it("MA = (O + H + L + sign×C) / 4", () => {
    const b = bar(0, 100, 110, 95, 105);
    const expectedMMA = (100 + 110 + 95 + MMA_CLOSE_SIGN * 105) / 4;
    expect(mmaBar(b)).toBeCloseTo(expectedMMA, 10);
  });

  it("TMA over 1/2/3 candles = Σ(O+H+L+C) / (4×N), cumulative", () => {
    const st = newTmaState();
    const b1 = bar(0, 100, 110, 95, 105);
    const b2 = bar(1, 105, 115, 100, 110);
    const b3 = bar(2, 110, 120, 105, 115);

    tmaAccumulate(st, b1);
    expect(tmaValue(st)).toBeCloseTo((100 + 110 + 95 + 105) / 4, 10);

    tmaAccumulate(st, b2);
    expect(tmaValue(st)).toBeCloseTo((100 + 110 + 95 + 105 + 105 + 115 + 100 + 110) / 8, 10);

    tmaAccumulate(st, b3);
    expect(tmaValue(st)).toBeCloseTo(
      (100 + 110 + 95 + 105 + 105 + 115 + 100 + 110 + 110 + 120 + 105 + 115) / 12, 10);
  });

  it("a forming bar is included in the value but never folded into the state", () => {
    const st = newTmaState();
    tmaAccumulate(st, bar(0, 100, 110, 95, 105)); // closed: sum 410, N=1
    const forming = bar(1, 105, 115, 100, 110);   // sum 430

    expect(tmaValue(st, forming)).toBeCloseTo((410 + 430) / 8, 10);
    // State untouched — value without the forming bar is still the 1-candle TMA.
    expect(tmaValue(st)).toBeCloseTo(410 / 4, 10);
  });

  it("NaN (missing) bars are skipped — no contribution to sum or N", () => {
    const st = newTmaState();
    tmaAccumulate(st, { t: 0, o: NaN, h: NaN, l: NaN, c: NaN });
    expect(Number.isNaN(tmaValue(st))).toBe(true); // no valid bars yet

    tmaAccumulate(st, bar(1, 100, 110, 95, 105));
    tmaAccumulate(st, { t: 2, o: NaN, h: NaN, l: NaN, c: NaN });
    expect(tmaValue(st)).toBeCloseTo(410 / 4, 10); // still N=1

    // NaN forming bar falls back to closed-bars-only value.
    expect(tmaValue(st, { t: 3, o: NaN, h: NaN, l: NaN, c: NaN })).toBeCloseTo(410 / 4, 10);
  });
});
