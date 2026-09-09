import { describe, it, expect } from "vitest";
import type { OHLCBar, DashboardRow } from "../calc";
import {
  bucketKey,
  buildBucketMap,
  resolveRowOptionBars,
  fillGridSeries,
  gridEndFor,
  overlayOptionSide,
  MISSING_BAR,
} from "../modules/dashboard/strikeMerge";

const TF = 60_000; // 1m — the timeframe in the reported failure
const BASE = Date.UTC(2026, 8, 9, 5, 19, 0); // = 10:49:00 IST
const min = (i: number) => BASE + i * TF; // 10:49, 10:50, 10:51, 10:52, 10:53, ...

const bar = (t: number, price: number): OHLCBar => ({ t, o: price, h: price + 1, l: price - 1, c: price });

// Simulates Effect 1: build the continuous FUT grid, then overlay a strike's
// fetched option history onto every grid row.
const buildTable = (futBars: OHLCBar[], strikeBars: OHLCBar[], endExclusive: number, tfMs = TF) => {
  const grid = fillGridSeries(futBars, tfMs, endExclusive);
  const ceMap = buildBucketMap(strikeBars, tfMs);
  const empty = new Map<number, OHLCBar>();
  return grid.map((g) => ({
    t: g.t,
    fut: g,
    call: resolveRowOptionBars(g.t, ceMap, empty, tfMs).callBar,
  }));
};

describe("Module 1 — continuous minute timeline, strike is display-only", () => {
  it("REQ 2/7: the FUT grid never skips a minute even when the API omits some", () => {
    // API returned only 10:49 and 10:52; live window = 10:53
    const grid = fillGridSeries([bar(min(0), 800), bar(min(3), 805)], TF, min(4));
    expect(grid.map((g) => g.t)).toEqual([min(0), min(1), min(2), min(3)]);
  });

  it("REQ 4: holes carry the previous close forward as a flat synthetic FUT bar", () => {
    const grid = fillGridSeries([bar(min(0), 800), bar(min(3), 805)], TF, min(4));
    expect(grid[1]).toMatchObject({ t: min(1), o: 800, h: 800, l: 800, c: 800, isSynthetic: true });
    expect(grid[2]).toMatchObject({ t: min(2), c: 800, isSynthetic: true });
    expect(grid[3].c).toBe(805); // the real bar survives untouched
  });

  it("REQ 7: user's exact failure — 10:49..10:53 must NOT collapse to 10:49, 10:53", () => {
    const table = buildTable(
      [bar(min(0), 800), bar(min(4), 810)], // FUT only reported the ends
      [bar(min(0), 200), bar(min(4), 210)], // selected strike traded only at the ends
      min(4),
    );
    expect(table.map((r) => r.t)).toEqual([min(0), min(1), min(2), min(3)]);
    // middle rows exist, FUT carried forward, option "—"
    expect(Number.isNaN(table[1].call.c)).toBe(true);
    expect(table[1].fut.c).toBe(800);
  });

  it("REQ 3/16: a minute with no option trade shows '—' but the row still exists", () => {
    const table = buildTable(
      [bar(min(0), 800), bar(min(1), 800), bar(min(2), 800), bar(min(3), 800), bar(min(4), 800)],
      [bar(min(0), 200), bar(min(3), 203)], // strike traded at 10:49 and 10:52 only
      min(5),
    );
    expect(table).toHaveLength(5);
    expect(table[0].call.c).toBe(200);
    expect(Number.isNaN(table[1].call.c)).toBe(true);
    expect(Number.isNaN(table[2].call.c)).toBe(true);
    expect(table[3].call.c).toBe(203);
    expect(Number.isNaN(table[4].call.c)).toBe(true);
  });

  it("REQ 6/7: a stored candle is NEVER '—' after a strike switch (A → B → C → A)", () => {
    const fut = [0, 1, 2, 3, 4].map((i) => bar(min(i), 800 + i));
    const A = [0, 1, 2, 3, 4].map((i) => bar(min(i), 100 + i));
    const B = [0, 1, 2, 3, 4].map((i) => bar(min(i), 300 + i));
    const C = [0, 1, 2, 3, 4].map((i) => bar(min(i), 500 + i));

    const tA1 = buildTable(fut, A, min(5)).map((r) => r.call.c);
    const tB = buildTable(fut, B, min(5)).map((r) => r.call.c);
    const tC = buildTable(fut, C, min(5)).map((r) => r.call.c);
    const tA2 = buildTable(fut, A, min(5)).map((r) => r.call.c);

    expect(tA1).toEqual([100, 101, 102, 103, 104]); // no "—" — every candle exists
    expect(tB).toEqual([300, 301, 302, 303, 304]);
    expect(tC).toEqual([500, 501, 502, 503, 504]);
    expect(tA2).toEqual(tA1); // switching back is lossless
    // timeline identical across every switch
    for (const t of [tA1, tB, tC, tA2]) expect(t).toHaveLength(5);
  });

  it("REQ 3/10: option series is never carry-forwarded (no fabricated option OHLC)", () => {
    // fillGridSeries is only ever fed FUT/SPOT; option gaps come out MISSING
    const table = buildTable(
      [0, 1, 2].map((i) => bar(min(i), 800)),
      [bar(min(0), 200)], // only one option candle
      min(3),
    );
    expect(table[1].call).toMatchObject({ o: NaN, c: NaN });
    expect(table[2].call).toMatchObject({ o: NaN, c: NaN });
  });

  it("bucketKey: openTime drift of seconds still resolves to the same row", () => {
    expect(bucketKey(BASE + 400, TF)).toBe(BASE);
    expect(bucketKey(BASE + 58_000, TF)).toBe(BASE);
    const table = buildTable(
      [bar(min(0), 800), bar(min(1), 800)],
      [{ ...bar(min(0) + 1500, 200) }, { ...bar(min(1) + 45_000, 201) }], // drifted candles
      min(2),
    );
    expect(table[0].call.c).toBe(200);
    expect(table[1].call.c).toBe(201);
  });

  it("MISSING_BAR shape + 5m timeframe grid alignment", () => {
    expect([MISSING_BAR(BASE).o, MISSING_BAR(BASE).c].every(Number.isNaN)).toBe(true);
    const FIVE = 5 * 60_000;
    const start = Date.UTC(2026, 8, 9, 5, 15, 0);
    const grid = fillGridSeries([bar(start, 800), bar(start + 3 * FIVE, 810)], FIVE, start + 4 * FIVE);
    expect(grid.map((g) => g.t)).toEqual([start, start + FIVE, start + 2 * FIVE, start + 3 * FIVE]);
  });

  it("empty FUT series → empty grid (no rows fabricated from nothing)", () => {
    expect(fillGridSeries([], TF, min(5))).toEqual([]);
    expect(fillGridSeries(null, TF, min(5))).toEqual([]);
  });

  it("gridEndFor: live session → fill to the live window; post-close → stop near the last bar", () => {
    // live: last bar 2 min ago, window = now → grid ends at the window
    const liveEnd = gridEndFor([bar(min(0), 800), bar(min(2), 800)], TF, min(3));
    expect(liveEnd).toBe(min(3));

    // post-close: last bar hours before the current clock minute → capped at last + 21m
    const eveningWindow = min(0) + 5 * 60 * 60_000; // 5h later
    const closedEnd = gridEndFor([bar(min(0), 800)], TF, eveningWindow);
    expect(closedEnd).toBe(min(0) + TF + 20 * 60_000);
    // and the grid it produces is bounded, not thousands of flat rows
    const grid = fillGridSeries([bar(min(0), 800)], TF, closedEnd);
    expect(grid.length).toBe(21);
    expect(grid.every((g) => g.c === 800)).toBe(true);
  });
});

// ── CE / PE independence (overlayOptionSide) ─────────────────────────────────
const mkRow = (t: number, cePrice: number, pePrice: number): DashboardRow => ({
  t,
  call: bar(t, cePrice),
  put: bar(t, pePrice),
  future: { t, o: 800, h: 801, l: 799, c: 800 },
  spot: { t, o: 200_00, h: 200_01, l: 199_99, c: 200_00 },
  callMMA: cePrice, callTMA: cePrice, putMMA: pePrice, putTMA: pePrice,
  futureMMA: 800, futureTMA: 800, spotMMA: 20000, spotTMA: 20000,
  ranking: Math.max(cePrice, pePrice), rankingWinner: cePrice >= pePrice ? "call" : "put",
  smc: "SENTINEL-SMC", fib: "SENTINEL-FIB",
  rsi: 55.5, ema: 111, vwap: 222, ema200: 333,
  emaScore: 1, vwapScore: -1, totalScore: 0, rating: null, signal: null,
  oiMatrix: null,
});

describe("Module 1 — CE and PE are fully independent on strike switch", () => {
  const times = [0, 1, 2, 3, 4].map(min);
  const live = min(5); // every row closed
  const rows0 = times.map((t, i) => mkRow(t, 100 + i, 50 + i)); // CE strike A, PE strike X

  const ceB = times.map((t, i) => bar(t, 300 + i));
  const peY = times.map((t, i) => bar(t, 70 + i));

  it("changing the CALL strike rewrites ONLY call columns — PUT/FUT/SPOT/indicators byte-identical", () => {
    const { rows } = overlayOptionSide(rows0, "call", ceB, TF, live);
    expect(rows).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      // call side updated to strike B
      expect(rows[i].call.c).toBe(300 + i);
      expect(rows[i].callMMA).toBe(300 + i);
      // PUT side untouched
      expect(rows[i].put).toEqual(rows0[i].put);
      expect(rows[i].putMMA).toBe(rows0[i].putMMA);
      expect(rows[i].putTMA).toBe(rows0[i].putTMA);
      // timeline + indicators untouched
      expect(rows[i].future).toEqual(rows0[i].future);
      expect(rows[i].spot).toEqual(rows0[i].spot);
      expect(rows[i].rsi).toBe(55.5);
      expect(rows[i].ema).toBe(111);
      expect(rows[i].smc).toBe("SENTINEL-SMC");
      expect(rows[i].t).toBe(times[i]);
    }
  });

  it("changing the PUT strike rewrites ONLY put columns — CALL untouched", () => {
    const { rows } = overlayOptionSide(rows0, "put", peY, TF, live);
    for (let i = 0; i < 5; i++) {
      expect(rows[i].put.c).toBe(70 + i);
      expect(rows[i].putMMA).toBe(70 + i);
      expect(rows[i].call).toEqual(rows0[i].call);
      expect(rows[i].callMMA).toBe(rows0[i].callMMA);
      expect(rows[i].callTMA).toBe(rows0[i].callTMA);
    }
  });

  it("CE then PE overlays compose — both sides correct, timeline never collapses", () => {
    const afterCe = overlayOptionSide(rows0, "call", ceB, TF, live).rows;
    const afterPe = overlayOptionSide(afterCe, "put", peY, TF, live).rows;
    expect(afterPe.map((r) => r.t)).toEqual(times);
    expect(afterPe.map((r) => r.call.c)).toEqual([300, 301, 302, 303, 304]);
    expect(afterPe.map((r) => r.put.c)).toEqual([70, 71, 72, 73, 74]);
  });

  it("A → B → A on the CALL side restores strike A's exact call values; PUT never moves", () => {
    const ceA = times.map((t, i) => bar(t, 100 + i));
    const r1 = overlayOptionSide(rows0, "call", ceA, TF, live).rows;
    const r2 = overlayOptionSide(r1, "call", ceB, TF, live).rows;
    const r3 = overlayOptionSide(r2, "call", ceA, TF, live).rows;
    expect(r3.map((r) => r.call)).toEqual(r1.map((r) => r.call));
    expect(r3.map((r) => r.callMMA)).toEqual(r1.map((r) => r.callMMA));
    expect(r3.map((r) => r.put)).toEqual(rows0.map((r) => r.put)); // PUT identical throughout
  });

  it("a CALL minute with no stored candle → '—', row stays, PUT untouched", () => {
    const sparseCe = [ceB[0], ceB[2], ceB[4]]; // strike B untraded at 10:50 & 10:52
    const { rows } = overlayOptionSide(rows0, "call", sparseCe, TF, live);
    expect(rows).toHaveLength(5);
    expect(Number.isNaN(rows[1].call.c)).toBe(true);
    expect(Number.isNaN(rows[3].call.c)).toBe(true);
    expect(rows[0].call.c).toBe(300);
    // PUT still fully present
    expect(rows.every((r, i) => r.put.c === 50 + i)).toBe(true);
  });

  it("ranking recomputes from the new callMMA + the EXISTING putMMA (put DATA untouched)", () => {
    const bigCe = times.map((t) => bar(t, 9999));
    const { rows } = overlayOptionSide(rows0, "call", bigCe, TF, live);
    for (let i = 0; i < 5; i++) {
      expect(rows[i].ranking).toBe(9999);          // call now dominates
      expect(rows[i].rankingWinner).toBe("call");
      expect(rows[i].put.c).toBe(50 + i);          // put OHLC never changed
    }
  });
});
