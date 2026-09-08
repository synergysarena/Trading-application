import { describe, it, expect, beforeEach } from "vitest";
import type { Tick, Candle } from "@stock/shared";

// Pure simulator of the refined OHLC aggregator logic (mirrors ohlcAggregator.ts)
class TestOhlcAggregator {
  public activeCandles: Record<string, Record<string, Candle>> = {};
  public finalizedCandles: Candle[] = [];
  public lastKnownClose: Record<string, Record<string, number>> = {};
  public continuousSymbols = new Set(["NIFTY-SPOT", "NIFTY-FUT"]);

  public getBoundaryTime(timestamp: Date, timeframeMinutes: number): number {
    const timeMs = timestamp.getTime();
    const timeframeMs = timeframeMinutes * 60000;
    if (timeframeMinutes < 60) {
      return Math.floor(timeMs / timeframeMs) * timeframeMs;
    }
    const SESSION_OPEN_UTC_MINUTES = 3 * 60 + 45;
    const sessionOpenMs = SESSION_OPEN_UTC_MINUTES * 60000;
    const midnightMs = timeMs - (timeMs % (24 * 60 * 60000));
    const todaySessionOpenMs = midnightMs + sessionOpenMs;
    const offsetMs = timeMs - todaySessionOpenMs;
    if (offsetMs < 0) {
      const prevSessionOpenMs = todaySessionOpenMs - 24 * 60 * 60000;
      return prevSessionOpenMs + Math.floor((timeMs - prevSessionOpenMs) / timeframeMs) * timeframeMs;
    }
    return todaySessionOpenMs + Math.floor(offsetMs / timeframeMs) * timeframeMs;
  }

  // Grace applied ONLY to timer-based finalization (mirrors PROACTIVE_FINALIZE_GRACE_MS)
  public graceMs = 3000;

  // Mirrors finaliseCandle: never let a re-finalization shrink an already
  // captured real candle (the "flat bar overwrites the good bar" corruption).
  private finalise(candle: Candle) {
    const idx = this.finalizedCandles.findIndex(
      c => c.symbol === candle.symbol && c.timeframe === candle.timeframe && c.openTime === candle.openTime
    );
    if (idx < 0) {
      this.finalizedCandles.push({ ...candle });
      return;
    }
    const existing = this.finalizedCandles[idx];
    if (!existing.isSynthetic && !candle.isSynthetic) {
      this.finalizedCandles[idx] = {
        ...existing,
        open: existing.open,
        high: Math.max(existing.high, candle.high),
        low: Math.min(existing.low, candle.low),
        close: candle.close,
        volume: Math.max(existing.volume, candle.volume),
        isSynthetic: false,
      };
    } else {
      this.finalizedCandles[idx] = { ...candle };
    }
  }

  public aggregateOHLC(tick: Tick, timeframeMinutes: number, timeframeStr: string, nowMs?: number): Candle {
    const { symbol, ltp, timestamp, volume = 0 } = tick;

    if (!this.activeCandles[symbol]) this.activeCandles[symbol] = {};
    if (!this.lastKnownClose[symbol]) this.lastKnownClose[symbol] = {};
    this.lastKnownClose[symbol][timeframeStr] = ltp;

    const boundary = this.getBoundaryTime(timestamp, timeframeMinutes);
    const wallBoundary = this.getBoundaryTime(new Date(nowMs ?? timestamp.getTime()), timeframeMinutes);
    let candle = this.activeCandles[symbol][timeframeStr];

    const syntheticIdx = this.finalizedCandles.findIndex(
      c => c.symbol === symbol && c.timeframe === timeframeStr && c.openTime === boundary && c.isSynthetic
    );

    const mergeLateTickIntoFinalizedReal = (): Candle | null => {
      const idx = this.finalizedCandles.findIndex(
        c => c.symbol === symbol && c.timeframe === timeframeStr && c.openTime === boundary && !c.isSynthetic
      );
      if (idx < 0) return null;
      const fin = this.finalizedCandles[idx];
      fin.high = Math.max(fin.high, ltp);
      fin.low = Math.min(fin.low, ltp);
      fin.volume += volume;
      return fin;
    };

    if (!candle || candle.openTime < boundary) {
      if (candle) this.finalise(candle);

      if (syntheticIdx >= 0) {
        const syn = this.finalizedCandles[syntheticIdx];
        syn.open = ltp; syn.high = ltp; syn.low = ltp; syn.close = ltp;
        syn.volume = volume; syn.isSynthetic = false;
        candle = syn;
      } else if (!candle && boundary < wallBoundary) {
        // Late tick for an already-elapsed minute with no active candle.
        const merged = mergeLateTickIntoFinalizedReal();
        if (merged) return merged;
        return { symbol, timeframe: timeframeStr, open: ltp, high: ltp, low: ltp, close: ltp, openTime: boundary, volume, isSynthetic: false };
      } else {
        candle = { symbol, timeframe: timeframeStr, open: ltp, high: ltp, low: ltp, close: ltp, openTime: boundary, volume, isSynthetic: false };
      }
    } else if (candle.openTime === boundary) {
      candle.high = Math.max(candle.high, ltp);
      candle.low = Math.min(candle.low, ltp);
      candle.close = ltp;
      candle.volume += volume;
      candle.isSynthetic = false;
      if (syntheticIdx >= 0) this.finalizedCandles[syntheticIdx] = { ...candle };
    } else {
      // Out-of-order / late tick: synthetic replacement, else merge into finalized real, else drop.
      if (syntheticIdx >= 0) {
        const syn = this.finalizedCandles[syntheticIdx];
        syn.open = ltp; syn.high = ltp; syn.low = ltp; syn.close = ltp;
        syn.volume = volume; syn.isSynthetic = false;
        return syn;
      }
      const merged = mergeLateTickIntoFinalizedReal();
      if (merged) return merged;
      return candle;
    }

    this.activeCandles[symbol][timeframeStr] = candle;
    return candle;
  }

  // Simulates boundary checker tick for continuity
  public checkContinuity(nowMs: number, tfStr = "1m", tfMins = 1, sessionOpenMs = 0) {
    // 1. Finalize expired active candles — only after the grace period.
    for (const symbol of Object.keys(this.activeCandles)) {
      const candle = this.activeCandles[symbol][tfStr];
      if (!candle) continue;
      const nextBoundary = candle.openTime + tfMins * 60000;
      if (nowMs >= nextBoundary + this.graceMs) {
        this.finalise(candle);
        delete this.activeCandles[symbol][tfStr];
        this.lastKnownClose[symbol][tfStr] = candle.close;
      }
    }

    // 2. Continuity for continuous symbols only (NIFTY-SPOT and NIFTY-FUT)
    for (const symbol of this.continuousSymbols) {
      const prevClose = this.lastKnownClose[symbol]?.[tfStr];
      if (prevClose === undefined || prevClose <= 0) continue;

      const currentBoundary = this.getBoundaryTime(new Date(nowMs), tfMins);
      const prevBoundary = currentBoundary - tfMins * 60000;

      if (prevBoundary < sessionOpenMs) continue;

      const active = this.activeCandles[symbol]?.[tfStr];
      if (active && active.openTime >= prevBoundary) continue;

      const hasFinalized = this.finalizedCandles.some(c => c.symbol === symbol && c.timeframe === tfStr && c.openTime === prevBoundary);
      if (hasFinalized) continue;

      const syntheticCandle: Candle = {
        symbol,
        timeframe: tfStr,
        open: prevClose,
        high: prevClose,
        low: prevClose,
        close: prevClose,
        openTime: prevBoundary,
        volume: 0,
        isSynthetic: true,
      };
      this.finalise(syntheticCandle);
    }
  }
}

describe("Module 1 OHLC Aggregator Logic", () => {
  let aggregator: TestOhlcAggregator;

  beforeEach(() => {
    aggregator = new TestOhlcAggregator();
  });

  it("Initializes first tick: Open=High=Low=Close=tickPrice", () => {
    const t0 = new Date("2026-08-24T04:30:05.000Z"); // 10:00:05 IST
    const candle = aggregator.aggregateOHLC(
      { symbol: "NIFTY-FUT", ltp: 24288.10, timestamp: t0, volume: 50 },
      1,
      "1m"
    );

    expect(candle.open).toBe(24288.10);
    expect(candle.high).toBe(24288.10);
    expect(candle.low).toBe(24288.10);
    expect(candle.close).toBe(24288.10);
    expect(candle.volume).toBe(50);
    expect(candle.isSynthetic).toBe(false);
  });

  it("Aggregates multiple ticks in the same minute correctly", () => {
    const minute = "2026-08-24T04:30:"; // 10:00 IST
    const ticks = [
      { ltp: 100.10, ts: new Date(`${minute}05.000Z`), vol: 10 },
      { ltp: 100.40, ts: new Date(`${minute}15.000Z`), vol: 20 },
      { ltp: 99.90,  ts: new Date(`${minute}30.000Z`), vol: 15 },
      { ltp: 100.20, ts: new Date(`${minute}55.000Z`), vol: 25 },
    ];

    let lastCandle!: Candle;
    for (const t of ticks) {
      lastCandle = aggregator.aggregateOHLC(
        { symbol: "NIFTY-FUT", ltp: t.ltp, timestamp: t.ts, volume: t.vol },
        1,
        "1m"
      );
    }

    expect(lastCandle.open).toBe(100.10);
    expect(lastCandle.high).toBe(100.40);
    expect(lastCandle.low).toBe(99.90);
    expect(lastCandle.close).toBe(100.20);
    expect(lastCandle.volume).toBe(70);
  });

  it("Consecutive minutes maintain independent OHLC state without inheriting previous values", () => {
    // Minute 1: 10:00
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24200.0, timestamp: new Date("2026-08-24T04:30:10.000Z") }, 1, "1m");
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24250.0, timestamp: new Date("2026-08-24T04:30:30.000Z") }, 1, "1m");
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24190.0, timestamp: new Date("2026-08-24T04:30:50.000Z") }, 1, "1m");

    // Minute 2: 10:01
    const m2_1 = aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24220.0, timestamp: new Date("2026-08-24T04:31:05.000Z") }, 1, "1m");
    expect(m2_1.open).toBe(24220.0);
    expect(m2_1.high).toBe(24220.0);
    expect(m2_1.low).toBe(24220.0);
    expect(m2_1.close).toBe(24220.0);

    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24230.0, timestamp: new Date("2026-08-24T04:31:40.000Z") }, 1, "1m");

    // Minute 3: 10:02
    const m3_1 = aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24210.0, timestamp: new Date("2026-08-24T04:32:02.000Z") }, 1, "1m");
    expect(m3_1.open).toBe(24210.0);
    expect(m3_1.high).toBe(24210.0);
    expect(m3_1.low).toBe(24210.0);
    expect(m3_1.close).toBe(24210.0);

    // Verify finalized candles
    expect(aggregator.finalizedCandles.length).toBe(2);
    // 10:00 candle
    expect(aggregator.finalizedCandles[0].open).toBe(24200.0);
    expect(aggregator.finalizedCandles[0].high).toBe(24250.0);
    expect(aggregator.finalizedCandles[0].low).toBe(24190.0);
    expect(aggregator.finalizedCandles[0].close).toBe(24190.0);

    // 10:01 candle
    expect(aggregator.finalizedCandles[1].open).toBe(24220.0);
    expect(aggregator.finalizedCandles[1].high).toBe(24230.0);
    expect(aggregator.finalizedCandles[1].low).toBe(24220.0);
    expect(aggregator.finalizedCandles[1].close).toBe(24230.0);
  });

  it("Generates synthetic carry-forward candle for NIFTY-FUT when a minute receives no ticks", () => {
    // Minute 10:00 (has ticks)
    const t0 = new Date("2026-08-24T04:30:10.000Z");
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24200.0, timestamp: t0 }, 1, "1m");

    // Finalize 10:00 at 10:01:00
    aggregator.checkContinuity(new Date("2026-08-24T04:31:05.000Z").getTime(), "1m", 1); // past 3s grace
    expect(aggregator.finalizedCandles.length).toBe(1);
    expect(aggregator.finalizedCandles[0].isSynthetic).toBe(false);

    // Minute 10:01 has NO ticks at all! Time advances to 10:02:01
    aggregator.checkContinuity(new Date("2026-08-24T04:32:05.000Z").getTime(), "1m", 1); // past 3s grace

    // Should now have 2 finalized candles: 10:00 (real) and 10:01 (synthetic carry-forward)
    expect(aggregator.finalizedCandles.length).toBe(2);
    const synCandle = aggregator.finalizedCandles[1];
    expect(synCandle.openTime).toBe(new Date("2026-08-24T04:31:00.000Z").getTime());
    expect(synCandle.open).toBe(24200.0);
    expect(synCandle.high).toBe(24200.0);
    expect(synCandle.low).toBe(24200.0);
    expect(synCandle.close).toBe(24200.0);
    expect(synCandle.volume).toBe(0);
    expect(synCandle.isSynthetic).toBe(true);
  });

  it("Does NOT generate synthetic candles for option contracts when no ticks arrive", () => {
    // Option tick at 10:00
    aggregator.aggregateOHLC({ symbol: "NIFTY26AUG24200C", ltp: 110.0, timestamp: new Date("2026-08-24T04:30:10.000Z") }, 1, "1m");

    // Finalize 10:00
    aggregator.checkContinuity(new Date("2026-08-24T04:31:05.000Z").getTime(), "1m", 1); // past 3s grace
    expect(aggregator.finalizedCandles.filter(c => c.symbol === "NIFTY26AUG24200C").length).toBe(1);

    // Minute 10:01 has no option ticks
    aggregator.checkContinuity(new Date("2026-08-24T04:32:05.000Z").getTime(), "1m", 1); // past 3s grace

    // Option should NOT have a synthetic 10:01 candle
    const optionCandles = aggregator.finalizedCandles.filter(c => c.symbol === "NIFTY26AUG24200C");
    expect(optionCandles.length).toBe(1);
  });

  it("Replaces synthetic candle with real tick if a real tick arrives matching that exact minute boundary", () => {
    // Minute 10:00
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24200.0, timestamp: new Date("2026-08-24T04:30:10.000Z") }, 1, "1m");
    aggregator.checkContinuity(new Date("2026-08-24T04:31:05.000Z").getTime(), "1m", 1); // past 3s grace

    // Minute 10:01: no tick yet -> synthetic candle created at 10:02
    aggregator.checkContinuity(new Date("2026-08-24T04:32:05.000Z").getTime(), "1m", 1); // past 3s grace
    expect(aggregator.finalizedCandles[1].isSynthetic).toBe(true);

    // Real tick with broker timestamp in 10:01 (e.g. 10:01:45) arrives
    const realTick = { symbol: "NIFTY-FUT", ltp: 24215.5, timestamp: new Date("2026-08-24T04:31:45.000Z"), volume: 100 };
    aggregator.aggregateOHLC(realTick, 1, "1m");

    // The 10:01 candle is now updated to real
    const updatedCandle = aggregator.finalizedCandles[1];
    expect(updatedCandle.isSynthetic).toBe(false);
    expect(updatedCandle.close).toBe(24215.5);
    expect(updatedCandle.volume).toBe(100);
  });

  it("Ignores late/out-of-order ticks without corrupting newer active candle", () => {
    // Minute 10:01 active
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24300.0, timestamp: new Date("2026-08-24T04:31:10.000Z") }, 1, "1m");

    // Late tick arrives with timestamp from 10:00 (where 10:00 already had real ticks)
    const activeBefore = { ...aggregator.activeCandles["NIFTY-FUT"]["1m"] };
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 99999.0, timestamp: new Date("2026-08-24T04:30:50.000Z") }, 1, "1m");
    const activeAfter = aggregator.activeCandles["NIFTY-FUT"]["1m"];

    expect(activeAfter.open).toBe(activeBefore.open);
    expect(activeAfter.high).toBe(activeBefore.high);
    expect(activeAfter.low).toBe(activeBefore.low);
    expect(activeAfter.close).toBe(activeBefore.close);
  });

  // ── Regression: late-tick-after-proactive-finalization corruption ──────────
  // Before the fix: the boundary checker finalized a multi-tick 10:00 candle at
  // exactly 10:01:00; a feed-lagged in-minute tick arriving at ~10:01:01 then
  // recreated a fresh 1-tick candle for 10:00 which, on its own finalization,
  // OVERWROTE the correct 10:00 candle (cache + MongoDB) with a flat bar.

  it("grace period keeps a feed-lagged in-minute tick in the same candle (no premature finalize)", () => {
    // 10:00 candle: two ticks
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 100, timestamp: new Date("2026-08-24T04:30:10.000Z") }, 1, "1m");
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 105, timestamp: new Date("2026-08-24T04:30:40.000Z") }, 1, "1m");

    // Boundary checker fires at 10:01:00.5 — WITHIN the 3s grace → must NOT finalize yet.
    aggregator.checkContinuity(new Date("2026-08-24T04:31:00.500Z").getTime(), "1m", 1);
    expect(aggregator.finalizedCandles.length).toBe(0);
    expect(aggregator.activeCandles["NIFTY-FUT"]["1m"].openTime).toBe(new Date("2026-08-24T04:30:00.000Z").getTime());

    // A feed-lagged tick for 10:00 (ft=10:00:58) arrives at wall-clock 10:01:01
    const c = aggregator.aggregateOHLC(
      { symbol: "NIFTY-FUT", ltp: 96, timestamp: new Date("2026-08-24T04:30:58.000Z") },
      1, "1m",
      new Date("2026-08-24T04:31:01.000Z").getTime()
    );
    // It lands in the SAME 10:00 candle and extends the low.
    expect(c.openTime).toBe(new Date("2026-08-24T04:30:00.000Z").getTime());
    expect(c.open).toBe(100);
    expect(c.high).toBe(105);
    expect(c.low).toBe(96);

    // Now finalize past the grace.
    aggregator.checkContinuity(new Date("2026-08-24T04:31:04.000Z").getTime(), "1m", 1);
    expect(aggregator.finalizedCandles).toHaveLength(1);
    expect([
      aggregator.finalizedCandles[0].open,
      aggregator.finalizedCandles[0].high,
      aggregator.finalizedCandles[0].low,
    ]).toEqual([100, 105, 96]);
  });

  it("a late tick AFTER finalization extends the finalized candle's H/L, never collapses it", () => {
    // 10:00 candle: O=100 H=105 L=98 C=102 (multi-tick), finalized past grace.
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 100, timestamp: new Date("2026-08-24T04:30:05.000Z") }, 1, "1m");
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 105, timestamp: new Date("2026-08-24T04:30:20.000Z") }, 1, "1m");
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 98,  timestamp: new Date("2026-08-24T04:30:40.000Z") }, 1, "1m");
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 102, timestamp: new Date("2026-08-24T04:30:55.000Z") }, 1, "1m");
    aggregator.checkContinuity(new Date("2026-08-24T04:31:05.000Z").getTime(), "1m", 1);
    expect(aggregator.finalizedCandles).toHaveLength(1);
    const before = { ...aggregator.finalizedCandles[0] };
    expect([before.open, before.high, before.low, before.close]).toEqual([100, 105, 98, 102]);

    // Feed-lagged tick for 10:00 arrives at wall-clock 10:01:07 with a NEW low.
    aggregator.aggregateOHLC(
      { symbol: "NIFTY-FUT", ltp: 95, timestamp: new Date("2026-08-24T04:30:59.000Z"), volume: 3 },
      1, "1m",
      new Date("2026-08-24T04:31:07.000Z").getTime()
    );

    // Still exactly ONE 10:00 candle. Open/close preserved, low extended — NOT a flat 95/95/95/95 bar.
    const tenAm = aggregator.finalizedCandles.filter(c => c.openTime === new Date("2026-08-24T04:30:00.000Z").getTime());
    expect(tenAm).toHaveLength(1);
    expect(tenAm[0].open).toBe(100);
    expect(tenAm[0].high).toBe(105);
    expect(tenAm[0].low).toBe(95);
    expect(tenAm[0].close).toBe(102);
    // No bogus active candle for the past minute was created.
    expect(aggregator.activeCandles["NIFTY-FUT"]["1m"]).toBeUndefined();
  });

  it("finalise() never lets a re-finalization shrink an already-captured real candle", () => {
    // Directly exercise the merge-guard: a good candle already finalized…
    (aggregator as any).finalise({ symbol: "NIFTY-FUT", timeframe: "1m", open: 100, high: 110, low: 90, close: 105, openTime: 1000, volume: 500, isSynthetic: false });
    // …then a stray flat re-finalization for the same minute.
    (aggregator as any).finalise({ symbol: "NIFTY-FUT", timeframe: "1m", open: 96, high: 96, low: 96, close: 96, openTime: 1000, volume: 1, isSynthetic: false });

    const c = aggregator.finalizedCandles.find(x => x.openTime === 1000)!;
    expect(aggregator.finalizedCandles.filter(x => x.openTime === 1000)).toHaveLength(1);
    expect(c.open).toBe(100);   // original open kept
    expect(c.high).toBe(110);   // not shrunk
    expect(c.low).toBe(90);     // not shrunk (96 > 90)
    expect(c.close).toBe(96);   // close follows the latest
    expect(c.volume).toBe(500); // larger volume kept, not overwritten with 1
  });

  it("a genuine single-tick minute still finalizes as a valid flat candle (not treated as a bug)", () => {
    aggregator.aggregateOHLC({ symbol: "NIFTY-SPOT", ltp: 24123.0, timestamp: new Date("2026-08-24T04:30:30.000Z") }, 1, "1m");
    aggregator.checkContinuity(new Date("2026-08-24T04:31:05.000Z").getTime(), "1m", 1);
    const c = aggregator.finalizedCandles[0];
    expect([c.open, c.high, c.low, c.close]).toEqual([24123.0, 24123.0, 24123.0, 24123.0]);
    expect(c.isSynthetic).toBe(false);
  });
});
