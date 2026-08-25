// DOM-level verification of the C Sign / P Sign column STYLING: renders the
// REAL Worksheet component (same code path as the running UI) and asserts
// the exact CELL BACKGROUND present in the produced markup now that C Sign /
// P Sign use the SAME Blue/Green/Pink/Black live-color engine as every other
// tracked column (see cellColorRules.ts TRACKED_COLUMNS "c-sign"/"p-sign"),
// instead of their prior fixed Dark-Green/Black rule. The sign value itself
// is MA − TMA exactly as specified (driven here through callMMA/callTMA &
// putMMA/putTMA).

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardRow, OHLCBar } from "../../calc";
import { Worksheet } from "./Worksheet";

const flatBar = (t: number, px: number): OHLCBar => ({ t, o: px, h: px, l: px, c: px });

// C Sign = callMMA − callTMA · P Sign = putMMA − putTMA (spec formula).
function mkRow(t: number, cfg: { callMMA: number; callTMA: number; putMMA: number; putTMA: number }): DashboardRow {
  return {
    t,
    call: flatBar(t, 100), put: flatBar(t, 80),
    future: flatBar(t, 22000), spot: flatBar(t, 22000),
    callMMA: cfg.callMMA, callTMA: cfg.callTMA,
    putMMA: cfg.putMMA, putTMA: cfg.putTMA,
    futureMMA: 11000, futureTMA: 22000,
    spotMMA: 11000, spotTMA: 22000,
    ranking: 50, rankingWinner: "call",
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

// Pull the inline style of the <td> whose rendered text is exactly `text`.
function cellStyle(html: string, text: string): string {
  const re = new RegExp(`<td[^>]*style="([^"]*)"[^>]*>${text.replace(/[+\-]/g, "\\$&")}</td>`);
  const m = html.match(re);
  expect(m, `expected a <td> containing "${text}"`).not.toBeNull();
  return m![1];
}

describe("C Sign / P Sign rendered colors (final DOM output, shared 4-color engine)", () => {
  const t0 = Date.UTC(2026, 6, 20, 4, 0); // 09:30 IST
  const html = render([
    // Row 1: C Sign = 120 − 115 = +5 (positive → green)
    //        P Sign = 80 − 84 = −4 (negative → black)
    mkRow(t0, { callMMA: 120, callTMA: 115, putMMA: 80, putTMA: 84 }),
    // Row 2: C Sign = 100 − 110 = −10 (negative → black)
    //        P Sign = 90 − 84 = +6 (highest positive → blue)
    mkRow(t0 + 300000, { callMMA: 100, callTMA: 110, putMMA: 90, putTMA: 84 }),
    // Row 3: C Sign = 115 − 115 = 0 (zero → black)
    //        P Sign = 84 − 84 = 0 (zero → black)
    mkRow(t0 + 600000, { callMMA: 115, callTMA: 115, putMMA: 84, putTMA: 84 }),
  ]);

  it("positive values use green, and the highest positive becomes blue", () => {
    expect(cellStyle(html, "5")).toContain("background:#1E3A8A");
    expect(cellStyle(html, "6")).toContain("background:#1E3A8A");
  });

  it("negative and zero values use black", () => {
    expect(cellStyle(html, "-10")).toContain("background:#111827");
    expect(cellStyle(html, "-4")).toContain("background:#111827");
    expect(cellStyle(html, "0")).toContain("background:#111827");
  });
});
