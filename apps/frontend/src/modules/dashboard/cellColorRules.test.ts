import { describe, it, expect } from "vitest";
import { buildLiveColorGrid, colorClassStyle, isColorableValue, TRACKED_COLUMN_THEME } from "./cellColorRules";
import type { DashboardRow, OHLCBar } from "../../calc";

function bar(o: number): OHLCBar {
  return { t: 0, o, h: o, l: o, c: o };
}

function rowWithCallOpen(o: number): DashboardRow {
  return {
    t: 0,
    call: bar(o), put: bar(1), future: bar(1), spot: bar(1),
    callMMA: 1, callTMA: 1, putMMA: 1, putTMA: 1,
    futureMMA: 1, futureTMA: 1, spotMMA: 1, spotTMA: 1,
    ranking: 1, rankingWinner: "call",
    smc: "", fib: "", rsi: null, ema: null, vwap: null, ema200: null,
    emaScore: null, vwapScore: null, totalScore: null, rating: null, signal: null,
    oiMatrix: null,
  } as DashboardRow;
}

function rowWithCallHigh(h: number): DashboardRow {
  const row = rowWithCallOpen(1);
  return { ...row, call: { ...row.call, h } };
}

describe("buildLiveColorGrid — Rule 1 applied literally: 'Current > Highest -> Blue; Highest = Current'", () => {
  // NOTE: the spec's narrative walkthroughs (e.g. "56 -> Light Green, 57 ->
  // Light Green, 60 -> Blue" for a clean 55..60 climb) are inconsistent with
  // the spec's own formal Rule 1 definition taken literally: 56 IS strictly
  // greater than the only prior value (55), which makes it "the highest
  // value reached within the currently selected timeframe" by definition, so
  // a literal reading makes every strictly-increasing step Blue, not just
  // the last one. This is confirmed unambiguously by the spec's OTHER worked
  // example ("Highest = 100, Previous = 82, Current = 85 -> Light Green",
  // tested below) — that example only makes sense if "Highest" is a
  // continuously-updating running max checked on every tick, which is
  // exactly what's implemented here. Every strict new-high tick during a
  // clean rally being highlighted Blue is also standard "new session high"
  // trading-UI behavior. Flagged for the team in case the narrative
  // walkthroughs reflect a different intended nuance.
  it("55,56,57,60,58,44,61 -> null,null,null,null,pink,black,blue (blue is singleton; pink/black split on whether the drop is a new all-time low)", () => {
    const values = [55, 56, 57, 60, 58, 44, 61];
    const rows = values.map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"]).toEqual([null, null, null, null, "pink", "black", "blue"]);
  });

  it("color-details.md sequence: 55,56,57,58,59,60,58,56,44 -> only the LAST new high (60) stays blue; the two small drops stay pink, the big drop (44) is black", () => {
    const values = [55, 56, 57, 58, 59, 60, 58, 56, 44];
    const rows = values.map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"]).toEqual([
      null, null, null, null, null, "blue", "pink", "pink", "black",
    ]);
  });

  it("highest resets only when the row array itself is rebuilt (new reference)", () => {
    const rows1 = [55, 56, 60].map(rowWithCallOpen);
    const grid1 = buildLiveColorGrid(rows1);
    expect(grid1["ce-o"]).toEqual([null, null, "blue"]); // 56's blue is erased once 60 becomes the new highest

    // Simulate a timeframe switch: rows array rebuilt from scratch.
    const rows2 = [10, 20].map(rowWithCallOpen);
    const grid2 = buildLiveColorGrid(rows2);
    expect(grid2["ce-o"]).toEqual([null, "blue"]); // 20 is a new high in the FRESH series, not compared to 60
  });

  it("blue is a singleton: only the most recent new-highest row stays blue, earlier ones are repainted null", () => {
    const values = [55, 56, 57, 58, 59, 60, 58, 61, 59, 70];
    const rows = values.map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    // Each new high (56,57,58,59,60,61,70) erases the PREVIOUS row's blue as
    // it's assigned, so only 70 (idx9), the final new high, survives. The two
    // drops (58,59) are both < 15% and stay pink (not singleton).
    expect(grid["ce-o"]).toEqual([
      null, null, null, null, null, null, "pink", null, "pink", "blue",
    ]);
  });

  it("black is a singleton: only the most recent new-lowest row stays black, earlier ones are repainted pink", () => {
    const values = [100, 80, 90, 70, 85, 60];
    const rows = values.map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    // Each new low (80,70,60) repaints the PREVIOUS row's black to pink as
    // it's assigned, so only 60 (idx5), the final new low, stays black.
    expect(grid["ce-o"]).toEqual([null, "pink", "green", "pink", "green", "black"]);
  });

  it("Highest=100 / previous=82 / current=85 -> green (not a new high)", () => {
    const rows = [100, 82, 85].map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"]).toEqual([null, "black", "green"]);
  });

  it("a drop that is NOT a new all-time low stays pink, not black — and doesn't disturb the existing black", () => {
    // 100 -> 90 is a new low -> black. 95 -> green (up, not a new high).
    // 92 is a drop but 92 > 90 (the running lowest), so it's pink, not a
    // new black — and the earlier black at idx1 is left untouched.
    const rows = [100, 90, 95, 92].map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"]).toEqual([null, "black", "green", "pink"]);
  });

  it("equal values now always receive a color (tie resolves to green, the non-decrease side) — no neutral/no-color state", () => {
    const rows = [220, 220, 220].map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"]).toEqual([null, "green", "green"]);
  });

  it("missing/invalid values (0, NaN) get no color and are skipped for tracking", () => {
    const rows = [50, 0, NaN, 55].map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    // 0 and NaN are invalid -> null; 55 compares against 50 (last valid), not 0
    expect(grid["ce-o"]).toEqual([null, null, null, "blue"]);
  });

  it("columns are fully independent (Call Open vs Put Open never influence each other)", () => {
    const rows: DashboardRow[] = [
      { ...rowWithCallOpen(50), put: bar(90) },
      { ...rowWithCallOpen(60), put: bar(80) }, // ce-o up -> blue, pe-o down -> pink
    ];
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"][1]).toBe("blue"); // 60 > 50, new high
    expect(grid["pe-o"][1]).toBe("black"); // 80 < 90, and it's a new low (first drop in the column)
  });

  it("isColorableValue treats 0/NaN/Infinity as invalid, negatives as valid", () => {
    expect(isColorableValue(0)).toBe(false);
    expect(isColorableValue(NaN)).toBe(false);
    expect(isColorableValue(Infinity)).toBe(false);
    expect(isColorableValue(-5)).toBe(true);
    expect(isColorableValue(5)).toBe(true);
  });
});

describe("special-column color rules for MA/TMA, Space, and Sign columns", () => {
  it("MA/TMA compare per row and then apply column-wide blue/black overrides", () => {
    const rows: DashboardRow[] = [
      { ...rowWithCallOpen(1), callMMA: 10, callTMA: 5 },
      { ...rowWithCallOpen(1), callMMA: 2, callTMA: 4 },
      { ...rowWithCallOpen(1), callMMA: 9, callTMA: 7 },
    ];

    const grid = buildLiveColorGrid(rows);
    expect(grid["mma-c"]).toEqual(["blue", "black", "green"]);
    expect(grid["tla-c"]).toEqual(["pink", "black", "blue"]);
  });

  it("SPACE uses positive/negative logic with blue/black overrides", () => {
    const rows: DashboardRow[] = [
      { ...rowWithCallOpen(1), callMMA: 10, callTMA: 5, putMMA: 1, putTMA: 1 },
      { ...rowWithCallOpen(1), callMMA: 1, callTMA: 1, putMMA: 1, putTMA: 1 },
      { ...rowWithCallOpen(1), callMMA: 3, callTMA: 1, putMMA: 1, putTMA: 1 },
    ];

    const grid = buildLiveColorGrid(rows);
    expect(grid["space"]).toEqual(["blue", null, "green"]);
  });

  it("C Sign / P Sign use green/blue/black only", () => {
    const rows: DashboardRow[] = [
      { ...rowWithCallOpen(1), callMMA: 5, callTMA: 0, putMMA: 1, putTMA: 2 },
      { ...rowWithCallOpen(1), callMMA: 6, callTMA: 0, putMMA: 2, putTMA: 1 },
      { ...rowWithCallOpen(1), callMMA: 0, callTMA: 0, putMMA: 0, putTMA: 0 },
    ];

    const grid = buildLiveColorGrid(rows);
    expect(grid["c-sign"]).toEqual(["green", "blue", "black"]);
    expect(grid["p-sign"]).toEqual(["black", "blue", "black"]);
  });
});

// ── High/Low/Close dark blue/black theme ──────────────────────────────────────
// Client revision: High/Low/Close (and now Open too — see the TRACKED_COLUMN_THEME
// check below) keep light green/pink but switch blue/black to the darker
// "dark" palette. The underlying color CLASS assigned per cell
// (blue/green/pink/black) is unchanged by this — only which CellColorStyle
// colorClassStyle() resolves it to differs. The green/pink hex values
// themselves (LIGHT_THEME_STYLE / DARK_THEME_STYLE) are untouched.
describe("High/Low/Close use light green/pink but dark blue/black (\"hlc\" theme)", () => {
  it("Call High reproduces the same singleton blue/black class sequence as Call Open", () => {
    const values = [55, 56, 57, 58, 59, 60, 58, 56, 44];
    const rows = values.map(rowWithCallHigh);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-h"]).toEqual([
      null, null, null, null, null, "blue", "pink", "pink", "black",
    ]);
  });

  it("colorClassStyle('blue'/'black', 'hlc') matches the dark theme; green/pink match the light theme", () => {
    const dark = colorClassStyle("blue", "dark");
    const light = colorClassStyle("green", "light");
    const lightPink = colorClassStyle("pink", "light");
    const darkBlack = colorClassStyle("black", "dark");

    expect(colorClassStyle("blue", "hlc")).toEqual(dark);
    expect(colorClassStyle("black", "hlc")).toEqual(darkBlack);
    expect(colorClassStyle("green", "hlc")).toEqual(light);
    expect(colorClassStyle("pink", "hlc")).toEqual(lightPink);
  });

  it("colorClassStyle('blue', 'light') still resolves to the light-blue swatch (the 'light' theme's own values are untouched)", () => {
    expect(colorClassStyle("blue", "light")).toEqual({ bg: "#BFDBFE", textColor: "#1E3A8A" });
  });

  it("dark-theme pink uses the requested dark red token", () => {
    expect(colorClassStyle("pink", "dark")).toEqual({ bg: "#B10202", textColor: "#FFFFFF" });
  });

  it("Open now uses the SAME 'hlc' theme as High/Low/Close (client revision), not the plain 'light' theme", () => {
    expect(TRACKED_COLUMN_THEME["ce-o"]).toBe("hlc");
    expect(TRACKED_COLUMN_THEME["pe-o"]).toBe("hlc");
    expect(TRACKED_COLUMN_THEME["fut-o"]).toBe("hlc");
    expect(TRACKED_COLUMN_THEME["spot-o"]).toBe("hlc");
    expect(TRACKED_COLUMN_THEME["ce-h"]).toBe("hlc");
    expect(TRACKED_COLUMN_THEME["ce-l"]).toBe("hlc");
    expect(TRACKED_COLUMN_THEME["ce-c"]).toBe("hlc");
  });
});

// ── Display-truncation consistency ────────────────────────────────────────────
// Regression coverage for a real client-reported defect: the color engine
// used to compare raw, full-precision values while the cell displays
// Math.trunc(value) — so two rows showing the identical on-screen number
// (e.g. both "19") could still get colored if their raw values differed by a
// fraction. The engine must compare the SAME truncated value the cell shows,
// so "visually unchanged" and "no color" always agree.
describe("buildLiveColorGrid — colors match the displayed (truncated) value, not the raw float", () => {
  it("raw values that display as the same integer are treated as a tie -> green (equal-value rule), not a real decrease", () => {
    // 19.6 -> 19.2: a real ~2% raw decrease, but both truncate to "19", so
    // the color engine treats it as an equal-value tie (green), not a drop.
    const rows = [19.6, 19.2].map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"]).toEqual([null, "green"]);
  });

  it("reproduces the client's reported dataset shape: 19.4, 19.2, 19.6, 19.1 (all display 19/19/19/19) -> tie-green on every row after the first", () => {
    const rows = [19.4, 19.2, 19.6, 19.1].map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"]).toEqual([null, "green", "green", "green"]);
  });

  it("still colors when the DISPLAYED integer actually changes, even by a fraction that crosses the boundary", () => {
    // 18.9 -> 19.1: displays as "18" then "19" — a real, visible change
    const rows = [18.9, 19.1].map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"]).toEqual([null, "blue"]);
  });

  it("highest tracking uses the truncated value too, so a raw-only new high that doesn't cross the display boundary is not a new high (tie -> green, not blue)", () => {
    // 20.9 (displays 20, becomes highest=20) -> 20.1 (still displays 20, tie
    // with prevValue=20 and not > highestBefore=20) -> green, not blue
    const rows = [20.9, 20.1].map(rowWithCallOpen);
    const grid = buildLiveColorGrid(rows);
    expect(grid["ce-o"]).toEqual([null, "green"]);
  });
});
