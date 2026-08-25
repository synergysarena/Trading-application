// DOM-level verification that Future/Spot Open/High/Low/Close/MA/TMA render
// WITHOUT a thousands-separator, while Call/Put OHLC/MA/TMA and Ranking keep
// their existing comma formatting. Renders the REAL Worksheet component so
// this checks actual produced markup, not just the formatter function in
// isolation.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardRow, OHLCBar } from "../../calc";
import { Worksheet } from "./Worksheet";

const flatBar = (t: number, px: number): OHLCBar => ({ t, o: px, h: px, l: px, c: px });

function mkRow(t: number): DashboardRow {
  return {
    t,
    // Distinct magnitudes per section (all >= 1000, so en-IN grouping would
    // insert a comma if it were still applied) so each section's assertion
    // can't accidentally match another section's cell.
    call: flatBar(t, 51340), put: flatBar(t, 13210),
    future: flatBar(t, 24210), spot: flatBar(t, 24210),
    callMMA: 51340, callTMA: 45000,
    putMMA: 13210, putTMA: 10000,
    // Deliberately DIFFERENT from the Future/Spot OHLC value (24210) so a
    // still-comma-formatted Future/Spot MA/TMA can never be mistaken for a
    // no-comma OHLC cell (or vice versa) in the assertions below.
    futureMMA: 90000, futureTMA: 80000,
    spotMMA: 90000, spotTMA: 80000,
    ranking: 51340, rankingWinner: "call",
    smc: "—", fib: "—", rsi: null, ema: null, vwap: null,
    ema200: null, emaScore: null, vwapScore: null, totalScore: null,
    rating: null, signal: null,
    oiMatrix: null,
  };
}

function render(rows: DashboardRow[]): string {
  return renderToStaticMarkup(createElement(Worksheet, {
    rows, hiddenCols: [], colOrder: [],
    feedStatus: "live", isLoading: false,
    type: "Call+Put", pivotMethod: "client",
  }));
}

describe("Future/Spot OHLC render without thousands separator", () => {
  const html = render([mkRow(Date.UTC(2026, 6, 20, 4, 0))]);

  it("Future Open/High/Low/Close show no comma, and 'Future' magnitude never appears WITH a comma anywhere", () => {
    // Future's own value (24210) is unique to Future/Spot in this fixture
    // (Call=51340, Put=13210), so a global comma-free check for this exact
    // magnitude is unambiguous.
    expect(html).not.toMatch(/24,210/);
    const matches = html.match(/<td[^>]*>24210<\/td>/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4); // Future O/H/L/C
  });

  it("Spot Open/High/Low/Close show no comma", () => {
    // Spot shares Future's value/count in this fixture — together they
    // account for all 8 no-comma occurrences at this magnitude.
    const matches = html.match(/<td[^>]*>24210<\/td>/g) ?? [];
    expect(matches.length).toBe(8); // 4 Future + 4 Spot
  });

  it("Call/Put OHLC keep the comma", () => {
    expect(html).toMatch(/>51,340</); // Call O/H/L/C
    expect(html).toMatch(/>13,210</); // Put O/H/L/C
  });

  it("Call/Put MA, TMA, Ranking keep the comma", () => {
    expect(html).toMatch(/>45,000</); // Call TMA
    expect(html).toMatch(/>51,340</); // Ranking (also covers Call MA, same value)
  });

  it("Future/Spot MA, TMA render WITHOUT a comma (client spec)", () => {
    // Future/Spot MA/TMA were moved to the no-comma formatter (p0NoGroup),
    // same as Future/Spot O/H/L/C — only Call/Put MA/TMA still group.
    expect(html).not.toMatch(/90,000/);
    expect(html).not.toMatch(/80,000/);
    expect(html).toMatch(/>90000</); // Future/Spot MA
    expect(html).toMatch(/>80000</); // Future/Spot TMA
  });
});
