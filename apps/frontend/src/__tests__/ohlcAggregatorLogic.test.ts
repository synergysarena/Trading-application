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

  public aggregateOHLC(tick: Tick, timeframeMinutes: number, timeframeStr: string): Candle {
    const { symbol, ltp, timestamp, volume = 0 } = tick;

    if (!this.activeCandles[symbol]) {
      this.activeCandles[symbol] = {};
    }
    if (!this.lastKnownClose[symbol]) {
      this.lastKnownClose[symbol] = {};
    }
    this.lastKnownClose[symbol][timeframeStr] = ltp;

    const boundary = this.getBoundaryTime(timestamp, timeframeMinutes);
    let candle = this.activeCandles[symbol][timeframeStr];

    const syntheticIdx = this.finalizedCandles.findIndex(
      c => c.symbol === symbol && c.timeframe === timeframeStr && c.openTime === boundary && c.isSynthetic
    );

    if (!candle || candle.openTime < boundary) {
      if (candle) {
        this.finalizedCandles.push({ ...candle });
      }

      if (syntheticIdx >= 0) {
        const syn = this.finalizedCandles[syntheticIdx];
        syn.open = ltp;
        syn.high = ltp;
        syn.low = ltp;
        syn.close = ltp;
        syn.volume = volume;
        syn.isSynthetic = false;
        candle = syn;
      } else {
        candle = {
          symbol,
          timeframe: timeframeStr,
          open: ltp,
          high: ltp,
          low: ltp,
          close: ltp,
          openTime: boundary,
          volume,
          isSynthetic: false,
        };
      }
    } else if (candle.openTime === boundary) {
      candle.high = Math.max(candle.high, ltp);
      candle.low = Math.min(candle.low, ltp);
      candle.close = ltp;
      candle.volume += volume;
      candle.isSynthetic = false;
      if (syntheticIdx >= 0) {
        this.finalizedCandles[syntheticIdx] = { ...candle };
      }
    } else {
      // Out-of-order / late tick: check if replacing a synthetic bar for this exact boundary
      if (syntheticIdx >= 0) {
        const syn = this.finalizedCandles[syntheticIdx];
        syn.open = ltp;
        syn.high = ltp;
        syn.low = ltp;
        syn.close = ltp;
        syn.volume = volume;
        syn.isSynthetic = false;
        return syn;
      }
      // Late tick for already finalized real candle — do not corrupt active candle
      return candle;
    }

    this.activeCandles[symbol][timeframeStr] = candle;
    return candle;
  }

  // Simulates boundary checker tick for continuity
  public checkContinuity(nowMs: number, tfStr = "1m", tfMins = 1, sessionOpenMs = 0) {
    // 1. Finalize expired active candles
    for (const symbol of Object.keys(this.activeCandles)) {
      const candle = this.activeCandles[symbol][tfStr];
      if (!candle) continue;
      const nextBoundary = candle.openTime + tfMins * 60000;
      if (nowMs >= nextBoundary) {
        this.finalizedCandles.push({ ...candle });
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
      this.finalizedCandles.push(syntheticCandle);
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
    aggregator.checkContinuity(new Date("2026-08-24T04:31:00.000Z").getTime(), "1m", 1);
    expect(aggregator.finalizedCandles.length).toBe(1);
    expect(aggregator.finalizedCandles[0].isSynthetic).toBe(false);

    // Minute 10:01 has NO ticks at all! Time advances to 10:02:01
    aggregator.checkContinuity(new Date("2026-08-24T04:32:01.000Z").getTime(), "1m", 1);

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
    aggregator.checkContinuity(new Date("2026-08-24T04:31:00.000Z").getTime(), "1m", 1);
    expect(aggregator.finalizedCandles.filter(c => c.symbol === "NIFTY26AUG24200C").length).toBe(1);

    // Minute 10:01 has no option ticks
    aggregator.checkContinuity(new Date("2026-08-24T04:32:01.000Z").getTime(), "1m", 1);

    // Option should NOT have a synthetic 10:01 candle
    const optionCandles = aggregator.finalizedCandles.filter(c => c.symbol === "NIFTY26AUG24200C");
    expect(optionCandles.length).toBe(1);
  });

  it("Replaces synthetic candle with real tick if a real tick arrives matching that exact minute boundary", () => {
    // Minute 10:00
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24200.0, timestamp: new Date("2026-08-24T04:30:10.000Z") }, 1, "1m");
    aggregator.checkContinuity(new Date("2026-08-24T04:31:00.000Z").getTime(), "1m", 1);

    // Minute 10:01: no tick yet -> synthetic candle created at 10:02
    aggregator.checkContinuity(new Date("2026-08-24T04:32:01.000Z").getTime(), "1m", 1);
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
});
