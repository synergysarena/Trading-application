import { describe, it, expect, beforeEach } from "vitest";
import type { Tick, Candle } from "@stock/shared";

// Pure simulator of the OHLC aggregator logic (mirrors ohlcAggregator.ts)
class TestOhlcAggregator {
  public activeCandles: Record<string, Record<string, Candle>> = {};
  public finalizedCandles: Candle[] = [];

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

    const boundary = this.getBoundaryTime(timestamp, timeframeMinutes);
    let candle = this.activeCandles[symbol][timeframeStr];

    if (!candle || candle.openTime < boundary) {
      if (candle) {
        this.finalizedCandles.push({ ...candle });
      }

      candle = {
        symbol,
        timeframe: timeframeStr,
        open: ltp,
        high: ltp,
        low: ltp,
        close: ltp,
        openTime: boundary,
        volume,
      };
    } else if (candle.openTime === boundary) {
      candle.high = Math.max(candle.high, ltp);
      candle.low = Math.min(candle.low, ltp);
      candle.close = ltp;
      candle.volume += volume;
    } else {
      // Late/out-of-order tick — do not corrupt the newer active candle
      return candle;
    }

    this.activeCandles[symbol][timeframeStr] = candle;
    return candle;
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

  it("Preserves decimal precision and does not round to integers", () => {
    const ts = new Date("2026-08-24T04:30:10.000Z");
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24288.10, timestamp: ts }, 1, "1m");
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24288.25, timestamp: new Date("2026-08-24T04:30:20.000Z") }, 1, "1m");
    const c = aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24287.90, timestamp: new Date("2026-08-24T04:30:40.000Z") }, 1, "1m");

    expect(c.open).toBe(24288.10);
    expect(c.high).toBe(24288.25);
    expect(c.low).toBe(24287.90);
    expect(c.close).toBe(24287.90);
  });

  it("Ensures strict instrument isolation (FUT, SPOT, CE, PE)", () => {
    const ts = new Date("2026-08-24T04:30:10.000Z");

    const fut = aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24300.50, timestamp: ts }, 1, "1m");
    const spot = aggregator.aggregateOHLC({ symbol: "NIFTY-SPOT", ltp: 24250.25, timestamp: ts }, 1, "1m");
    const ce = aggregator.aggregateOHLC({ symbol: "NIFTY26AUG24200C", ltp: 110.75, timestamp: ts }, 1, "1m");
    const pe = aggregator.aggregateOHLC({ symbol: "NIFTY26AUG24200P", ltp: 85.50, timestamp: ts }, 1, "1m");

    expect(fut.open).toBe(24300.50);
    expect(spot.open).toBe(24250.25);
    expect(ce.open).toBe(110.75);
    expect(pe.open).toBe(85.50);

    expect(aggregator.activeCandles["NIFTY-FUT"]["1m"].close).toBe(24300.50);
    expect(aggregator.activeCandles["NIFTY-SPOT"]["1m"].close).toBe(24250.25);
    expect(aggregator.activeCandles["NIFTY26AUG24200C"]["1m"].close).toBe(110.75);
    expect(aggregator.activeCandles["NIFTY26AUG24200P"]["1m"].close).toBe(85.50);
  });

  it("Ignores late/out-of-order ticks without corrupting newer active candle", () => {
    // Minute 10:01 active
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 24300.0, timestamp: new Date("2026-08-24T04:31:10.000Z") }, 1, "1m");

    // Late tick arrives with timestamp from 10:00
    const activeBefore = { ...aggregator.activeCandles["NIFTY-FUT"]["1m"] };
    aggregator.aggregateOHLC({ symbol: "NIFTY-FUT", ltp: 99999.0, timestamp: new Date("2026-08-24T04:30:50.000Z") }, 1, "1m");
    const activeAfter = aggregator.activeCandles["NIFTY-FUT"]["1m"];

    expect(activeAfter.open).toBe(activeBefore.open);
    expect(activeAfter.high).toBe(activeBefore.high);
    expect(activeAfter.low).toBe(activeBefore.low);
    expect(activeAfter.close).toBe(activeBefore.close);
  });
});
