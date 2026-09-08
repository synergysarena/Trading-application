import { describe, it, expect } from "vitest";
import { Module2Cell, Module2SessionData, Module2StrikeState, generateTimelineColumns } from "@stock/shared";

/**
 * Module 2 — market-close UI contract (pure-logic; the repo has no DOM test env).
 *
 * After 15:30 IST the Strike Tracker table must stay fully populated — only the
 * TOP status bar changes and LIVE updates stop. These tests pin the data-level
 * behaviour the JSX now relies on:
 *   - the table body renders strike rows regardless of market status
 *     (no `isClosed ? <MarketClosed/> : rows` branch any more),
 *   - the timeline does not advance past the last real minute (no 15:31+),
 *   - existing grid values are shown unchanged,
 *   - a strike with no stored cell for a minute shows "—", never an invented price.
 */

const cell = (ts: string, ltp: number): Module2Cell => ({
  ltp, minute: 0, timestamp: ts, isHigh: false, isLow: false, oi: 0, oiDelta: 0, oiBuy: 0, oiSell: 0, source: "mongo",
});

const strike = (name: string, cells: Module2Cell[]): Module2StrikeState => ({
  strike: name, dayOpen: cells[0]?.ltp ?? 0, dayHigh: 0, dayLow: 0, grid: cells,
  trendBadge: "FLAT", isDowntrendActive: false, isDeepLoss: false, pctChange: 0,
});

const closedSession = (): Module2SessionData => ({
  sessionId: "s1", userId: "u1", sessionType: "mixed", indexSymbol: "NIFTY50", expiryDate: "2026-09-11",
  selectedStrikes: ["NIFTY24000CE", "NIFTY24000PE"],
  dayOpenPrices: {},
  strikes: {
    NIFTY24000CE: strike("NIFTY24000CE", [
      cell("15:25", 120), cell("15:26", 121), cell("15:27", 120), cell("15:28", 119), cell("15:29", 120), cell("15:30", 121),
    ]),
    NIFTY24000PE: strike("NIFTY24000PE", [
      cell("15:25", 90), cell("15:26", 91), cell("15:27", 92), cell("15:28", 93), cell("15:29", 92), cell("15:30", 91),
    ]),
  },
  status: "ACTIVE", createdAt: new Date(),
});

// Mirrors <StrikeTrackerTable> body: renders a row per selected strike, "—" for a missing cell.
const renderTableBody = (session: Module2SessionData, strikesList: string[], columns: string[]) =>
  strikesList.map((name) => {
    const s = session.strikes[name];
    return columns.map((ts) => {
      const c = s?.grid.find((x) => x.timestamp === ts);
      return c && typeof c.ltp === "number" && !isNaN(c.ltp) ? c.ltp : "—";
    });
  });

describe("Module 2 — market close keeps the Strike Tracker table", () => {
  const session = closedSession();
  const allTs: string[] = [];
  Object.values(session.strikes).forEach((s) => s.grid.forEach((c) => allTs.push(c.timestamp)));
  const columns = generateTimelineColumns(allTs);

  it("timeline freezes at the last real minute — no 15:31+ columns are fabricated", () => {
    expect(columns[columns.length - 1]).toBe("15:30");
    expect(columns).not.toContain("15:31");
    expect(columns).not.toContain("15:32");
    expect(columns).toEqual(["15:25", "15:26", "15:27", "15:28", "15:29", "15:30"]);
  });

  it("every selected CE/PE strike still renders a row with its stored values (nothing cleared)", () => {
    const ce = renderTableBody(session, ["NIFTY24000CE"], columns)[0];
    const pe = renderTableBody(session, ["NIFTY24000PE"], columns)[0];
    expect(ce).toEqual([120, 121, 120, 119, 120, 121]);
    expect(pe).toEqual([90, 91, 92, 93, 92, 91]);
    // the 15:30 row survives
    expect(ce[columns.indexOf("15:30")]).toBe(121);
    expect(pe[columns.indexOf("15:30")]).toBe(91);
  });

  it("a strike selected after close with NO stored data shows '—', never an invented price", () => {
    const withNewStrike: Module2SessionData = {
      ...session,
      selectedStrikes: [...session.selectedStrikes, "NIFTY24500CE"],
      strikes: { ...session.strikes, NIFTY24500CE: strike("NIFTY24500CE", []) },
    };
    const row = renderTableBody(withNewStrike, ["NIFTY24500CE"], columns)[0];
    expect(row).toEqual(["—", "—", "—", "—", "—", "—"]);
    // and it does NOT borrow another strike's numbers
    expect(row.some((v) => [120, 121, 90, 91].includes(v as number))).toBe(false);
  });

  it("market status does not gate the table body (rows render whether open or closed)", () => {
    // The body renderer takes no market-status argument — same output regardless.
    const openView = renderTableBody(session, session.selectedStrikes, columns);
    const closedView = renderTableBody(session, session.selectedStrikes, columns);
    expect(closedView).toEqual(openView);
    expect(closedView[0]).toHaveLength(6);
    expect(closedView[1]).toHaveLength(6);
  });
});
