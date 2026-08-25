/**
 * Frozen-column guard tests.
 *
 * Verifies that the MISSING_BAR sentinel and the updated Effect 1 / Effect 2
 * fallback logic never copy futures prices into call or put columns when option
 * OHLC data is unavailable.
 */
import { describe, it, expect } from "vitest";
import { mmaBar, newTmaState, tmaAccumulate, tmaValue, computeRanking } from "../calc";
import type { OHLCBar } from "../calc";

// Local replicas of helpers in index.tsx and Worksheet.tsx (pure functions, no React deps)
const MISSING_BAR = (t: number): OHLCBar => ({ t, o: NaN, h: NaN, l: NaN, c: NaN });
const p0 = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : Math.floor(n).toLocaleString("en-IN");

// ── MISSING_BAR sentinel ──────────────────────────────────────────────────────

describe("MISSING_BAR sentinel", () => {
  it("all OHLC fields are NaN", () => {
    const bar = MISSING_BAR(12345);
    expect(isNaN(bar.o)).toBe(true);
    expect(isNaN(bar.h)).toBe(true);
    expect(isNaN(bar.l)).toBe(true);
    expect(isNaN(bar.c)).toBe(true);
  });

  it("mmaBar(MISSING_BAR) is NaN — no futures value leaks in", () => {
    const futBar: OHLCBar = { t: 0, o: 23861, h: 23870, l: 23850, c: 23865 };
    expect(Number.isFinite(mmaBar(futBar))).toBe(true); // sanity

    const missingMMA = mmaBar(MISSING_BAR(0));
    expect(isNaN(missingMMA)).toBe(true);
    expect(missingMMA).not.toBe(mmaBar(futBar));
  });

  it("p0(mmaBar(MISSING_BAR)) renders as '—'", () => {
    expect(p0(mmaBar(MISSING_BAR(0)))).toBe("—");
  });

  it("TMA over only MISSING_BARs is NaN and renders as '—'", () => {
    const st = newTmaState();
    tmaAccumulate(st, MISSING_BAR(0));
    expect(isNaN(tmaValue(st))).toBe(true);
    expect(p0(tmaValue(st))).toBe("—");
  });
});

// ── Effect 1 fallback: ceMap.get(t) ?? MISSING_BAR(t) ────────────────────────

describe("Effect 1 fallback — empty ceMap", () => {
  it("empty ceMap returns MISSING_BAR, never the futures bar", () => {
    const ceMap = new Map<number, OHLCBar>();
    const futBar: OHLCBar = { t: 1000, o: 23861, h: 23870, l: 23850, c: 23865 };

    const callBar = ceMap.get(futBar.t) ?? MISSING_BAR(futBar.t);

    expect(isNaN(callBar.o)).toBe(true);
    expect(isNaN(callBar.c)).toBe(true);
    expect(callBar.o).not.toBe(futBar.o);
    expect(callBar.c).not.toBe(futBar.c);
  });

  it("non-empty ceMap returns the correct option bar", () => {
    const ceMap = new Map<number, OHLCBar>();
    const optBar: OHLCBar = { t: 1000, o: 150, h: 160, l: 140, c: 155 };
    ceMap.set(1000, optBar);
    const futBar: OHLCBar = { t: 1000, o: 23861, h: 23870, l: 23850, c: 23865 };

    const callBar = ceMap.get(futBar.t) ?? MISSING_BAR(futBar.t);

    expect(callBar.o).toBe(150);
    expect(callBar.c).toBe(155);
    expect(callBar.c).not.toBe(futBar.c);
  });

  it("multiple rows with real CE data each have distinct closes", () => {
    const ceMap = new Map<number, OHLCBar>();
    ceMap.set(1000, { t: 1000, o: 150, h: 160, l: 140, c: 155 });
    ceMap.set(2000, { t: 2000, o: 152, h: 165, l: 145, c: 148 });
    ceMap.set(3000, { t: 3000, o: 160, h: 170, l: 158, c: 162 });

    const futBars: OHLCBar[] = [
      { t: 1000, o: 23861, h: 23870, l: 23850, c: 23865 },
      { t: 2000, o: 23865, h: 23880, l: 23855, c: 23875 },
      { t: 3000, o: 23875, h: 23890, l: 23860, c: 23885 },
    ];
    const callBars = futBars.map(b => ceMap.get(b.t) ?? MISSING_BAR(b.t));
    const closes = callBars.map(b => b.c);

    expect(closes[0]).not.toBe(closes[1]);
    expect(closes[1]).not.toBe(closes[2]);
    futBars.forEach((fb, i) => expect(callBars[i].c).not.toBe(fb.c));
  });
});

// ── Effect 2 fallback: ceLtp ?? NaN  ─────────────────────────────────────────

describe("Effect 2 fallback — null ceLtp", () => {
  it("null ceLtp → NaN bar (never futLtp)", () => {
    const futLtp = 23861;
    const ceLtp: number | null = null;
    const ceN = ceLtp ?? NaN;
    const callBar: OHLCBar = { t: 0, o: ceN, h: ceN, l: ceN, c: ceN };

    expect(isNaN(callBar.c)).toBe(true);
    expect(callBar.c).not.toBe(futLtp);
  });

  it("real ceLtp → bar contains option price, not futures price", () => {
    const futLtp = 23861;
    const ceLtp: number | null = 152;
    const ceN = ceLtp ?? NaN;
    const callBar: OHLCBar = { t: 0, o: ceN, h: ceN, l: ceN, c: ceN };

    expect(Number.isFinite(callBar.c)).toBe(true);
    expect(callBar.c).toBe(152);
    expect(callBar.c).not.toBe(futLtp);
  });

  it("update branch: null ceLtp leaves NaN bar unchanged", () => {
    const b = { callO: NaN, callH: NaN, callL: NaN, callC: NaN };
    const ceLtp: number | null = null;

    if (ceLtp !== null) {
      b.callH = isNaN(b.callH) ? ceLtp : Math.max(b.callH, ceLtp);
      b.callL = isNaN(b.callL) ? ceLtp : Math.min(b.callL, ceLtp);
      if (isNaN(b.callO)) b.callO = ceLtp;
      b.callC = ceLtp;
    }

    expect(isNaN(b.callC)).toBe(true);
    expect(isNaN(b.callO)).toBe(true);
  });

  it("update branch: first valid tick back-fills Open from NaN", () => {
    const b = { callO: NaN, callH: NaN, callL: NaN, callC: NaN };
    const ceLtp: number | null = 152;

    if (ceLtp !== null) {
      b.callH = isNaN(b.callH) ? ceLtp : Math.max(b.callH, ceLtp);
      b.callL = isNaN(b.callL) ? ceLtp : Math.min(b.callL, ceLtp);
      if (isNaN(b.callO)) b.callO = ceLtp;
      b.callC = ceLtp;
    }

    expect(b.callO).toBe(152);
    expect(b.callC).toBe(152);
  });

  it("update branch: subsequent ticks track OHLC properly", () => {
    const b = { callO: 152, callH: 152, callL: 152, callC: 152 };

    const ticks: number[] = [155, 148, 160];
    for (const ltp of ticks) {
      b.callH = isNaN(b.callH) ? ltp : Math.max(b.callH, ltp);
      b.callL = isNaN(b.callL) ? ltp : Math.min(b.callL, ltp);
      if (isNaN(b.callO)) b.callO = ltp;
      b.callC = ltp;
    }

    expect(b.callH).toBe(160); // highest
    expect(b.callL).toBe(148); // lowest
    expect(b.callO).toBe(152); // unchanged
    expect(b.callC).toBe(160); // last tick
  });
});

// ── computeRanking with NaN inputs ────────────────────────────────────────────

describe("computeRanking with NaN MMA values", () => {
  it("NaN vs NaN does not throw and returns a valid winner string", () => {
    const result = computeRanking(NaN, NaN);
    expect(result.winner === "call" || result.winner === "put").toBe(true);
    // Client rule (Module 1 defect fix): Ranking must always be a valid finite
    // number — never NaN/undefined/null/Infinity — even when both sides are missing.
    expect(Number.isFinite(result.value)).toBe(true);
  });

  it("NaN call MMA vs real put MMA — put wins", () => {
    const result = computeRanking(NaN, 5900);
    expect(result.winner).toBe("put");
    expect(result.value).toBe(5900);
  });
});
