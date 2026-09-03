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

describe("Table visible cells display whole numbers while title tooltips show original decimals", () => {
  function mkDecimalRow(t: number): DashboardRow {
    return {
      t,
      call: { t, o: 1.85, h: 1.95, l: 1.2, c: 1.45 },
      put: { t, o: 79.4, h: 515.25, l: 0.6, c: 79.4 },
      future: flatBar(t, 24213.75), spot: flatBar(t, 24213.75),
      callMMA: 1.61, callTMA: 1.58,
      putMMA: 168.66, putTMA: 150.2,
      futureMMA: 24210, futureTMA: 24210,
      spotMMA: 24210, spotTMA: 24210,
      ranking: 168.66, rankingWinner: "put",
      smc: "—", fib: "—", rsi: null, ema: null, vwap: null,
      ema200: null, emaScore: null, vwapScore: null, totalScore: null,
      rating: null, signal: null,
      oiMatrix: null,
    };
  }

  const html = render([mkDecimalRow(Date.UTC(2026, 6, 20, 4, 0))]);

  it("Visible table cells show only whole numbers via Math.trunc", () => {
    // Call OHLC (1.85, 1.95, 1.2, 1.45) all display as 1
    const callOpenCell = html.match(/<td[^>]*title="1\.85"[^>]*>1<\/td>/);
    expect(callOpenCell).not.toBeNull();
    const callHighCell = html.match(/<td[^>]*title="1\.95"[^>]*>1<\/td>/);
    expect(callHighCell).not.toBeNull();

    // Put Open (79.4) displays as 79, High (515.25) displays as 515, Low (0.6) displays as 0
    expect(html).toMatch(/<td[^>]*title="79\.4"[^>]*>79<\/td>/);
    expect(html).toMatch(/<td[^>]*title="515\.25"[^>]*>515<\/td>/);
    expect(html).toMatch(/<td[^>]*title="0\.6"[^>]*>0<\/td>/);

    // Future (24213.75) displays as 24213
    expect(html).toMatch(/<td[^>]*title="24213\.75"[^>]*>24213<\/td>/);
  });

  it("Hover tooltip (title attribute) contains the exact original decimal value", () => {
    expect(html).toMatch(/title="1\.85"/);
    expect(html).toMatch(/title="1\.95"/);
    expect(html).toMatch(/title="1\.2"/);
    expect(html).toMatch(/title="1\.45"/);
    expect(html).toMatch(/title="79\.4"/);
    expect(html).toMatch(/title="515\.25"/);
    expect(html).toMatch(/title="1\.61"/);
    expect(html).toMatch(/title="1\.58"/);
    expect(html).toMatch(/title="168\.66"/);
    expect(html).toMatch(/title="24213\.75"/);
  });

  it("Call/Put Sign columns do not produce -0 in display or tooltip", () => {
    expect(html).not.toMatch(/>-0</);
    expect(html).not.toMatch(/title="-0"/);
  });
});
